// autopilot.js — the self-driving playtest driver for Crescent Bay.
// It plays the whole game the way a player would: it walks the road
// graph, steals faster cars, chases the courier, fights shootouts in
// aimed bursts, buys the cheapest garage upgrade, and never stops under
// the helicopter spotlight. main.js runs updateAutopilot BEFORE the
// dialog branch every frame, so the autopilot can press E to accept a
// mission (spec section 9.1a) — and while it is active main.js swaps
// G.input to G.autoInput, so every system reads the autopilot's input.
//
// INPUT CONTRACT: the autopilot writes ONLY to G.autoInput (same shape
// as G.input: keys / pressed Sets, mouseX / mouseY / mouseDown /
// justClicked / interactPressed). It rebuilds autoInput.keys fresh every
// frame and sets edge flags for exactly one frame, so no key can stick.
// It never writes G.input: main.js owns that object and restores it.
//
// DRIVING CONTRACT: the autopilot drives the player's car DIRECTLY with
// the vehicles.js helpers (routeCarTo / driveRoute / driveCarToward) and
// sets G.autopilotDrove = true on those frames, so player.js syncs the
// player to the car instead of running the manual driving branch (which
// would brake the car back to ~0). On foot it writes WASD + Shift keys
// into autoInput and player.js walks from them.
//
// GARAGE DEADLOCK (main.js, read 22 Nov): openGarage sets G.paused =
// true and the frame loop skips stepGame entirely while paused — so an
// autopilot that opened the menu with E and waited for a later frame to
// buy would never run again. The m11 garage step therefore calls
// openGarage / buyUpgrade / closeGarage DIRECTLY, all inside one
// updateAutopilot call: menu opens, cheapest upgrade is bought, menu
// closes, the world never stalls. Builder C should fix main.js so the
// autopilot (and Esc) still run while the garage menu is open; until
// then this direct path is the only one that completes m11.
import { LANDMARKS } from './config.js';
import { createAutoInputState } from './input.js';
import { m2OnFootTarget, nearestRoadPoint } from './missions.js';
import { driveCarToward, driveRoute, routeCarTo, effectiveTopSpeed } from './vehicles.js';
import {
  cheapestAvailableUpgrade, buyUpgrade, openGarage, closeGarage, garageZone,
} from './garage.js';
import { currentAmmo, currentWeaponDef, selectWeapon, WEAPON_DEFS } from './weapons.js';

// Cruise speeds: the chase needs 520 against the courier's 380; timed
// legs run 520; ordinary go-to legs run 480.
export const AUTOPILOT_CHASE_CRUISE = 520;
export const AUTOPILOT_GOTO_CRUISE = 480;
export const AUTOPILOT_TIMED_CRUISE = 520;
// On-foot walk target memo: recompute only when the target moved >120.
export const AUTOPILOT_WALK_RECOMPUTE = 120;
// Shootout: one aimed burst every 0.45s, never spray. Grab arena ammo
// at 6 or fewer shells left; grab a health pickup below 45 HP.
export const AUTOPILOT_SHOOT_BURST_INTERVAL = 0.45;
export const AUTOPILOT_AMMO_PICKUP_AT = 6;
export const AUTOPILOT_HEALTH_PICKUP_BELOW = 60;
// Leave a slow car for a much faster parked car nearby — only when the
// current top speed is below the threshold and the parked car is within
// range. Switching cars is a theft that adds heat, so the gain must be
// real (at least 60 faster), never marginal.
export const AUTOPILOT_SWITCH_GOTO_SPEED = 350;
export const AUTOPILOT_SWITCH_CHASE_SPEED = 430;
export const AUTOPILOT_SWITCH_GOTO_RANGE = 200;
export const AUTOPILOT_SWITCH_CHASE_RANGE = 320;
export const AUTOPILOT_SWITCH_MIN_GAIN = 60;
// How far the autopilot looks for a parked car while on foot.
export const AUTOPILOT_CAR_SEARCH_RANGE = 800;
// Player.js lets E enter a car within 62; the autopilot walks to 50.
export const AUTOPILOT_ENTER_RANGE = 50;
// Aimed range per weapon: walk straight to the nearest enemy until
// inside this distance, then shoot.
export const AUTOPILOT_SHOOT_RANGE = { pistol: 300, smg: 260, shotgun: 180 };

const ROADS = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];

export function createAutopilotState() {
  return {
    enabled: false,
    mode: 'idle',
    // Memoized on-foot walk: route + the target it was computed for.
    walkTarget: null,
    walkTargetFor: null,
    walkRoute: null,
    walkRouteIndex: 0,
    walkDirect: false,
    // Car switching: the specific car being walked to, and the car just
    // abandoned (never re-enter it — v2 lesson: exit/enter loop).
    targetCar: null,
    abandonedCarId: null,
    abandonedUntil: 0,
    // Shootout pacing.
    shootTimer: 0,
    burstHold: 0,
    weaponChosen: false,
    lastShootKey: '',
    // Chase ram reset: backing off to a run-up point after a touch.
    ramReset: false,
    ramResetTarget: null,
    // Garage (m11) step.
    garageStep: 'drive',
  };
}

export function ensureAutopilotState(G) {
  if (!G.autopilot) G.autopilot = createAutopilotState();
  if (!G.autoInput) G.autoInput = createAutoInputState();
  if (typeof G.autopilotActive !== 'boolean') G.autopilotActive = false;
  return G.autopilot;
}

// Playtest harness entry points: enable / disable the driver.
export function enableAutopilot(G) {
  ensureAutopilotState(G);
  G.autopilot.enabled = true;
  G.autopilotActive = true;
  return true;
}

export function disableAutopilot(G) {
  ensureAutopilotState(G);
  G.autopilot.enabled = false;
  G.autopilotActive = false;
  G.autopilotDrove = false;
  return true;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function playerPos(G) {
  const p = G.player;
  if (!p) return { x: 0, y: 0 };
  if (p.car) return { x: p.car.x, y: p.car.y };
  return { x: p.x, y: p.y };
}

function angleTo(fx, fy, tx, ty) {
  return Math.atan2(ty - fy, tx - fx);
}

// Aim the mouse at a world point (screen = world - camera) and keep
// G.player.aimAngle in sync, so the shot goes where the autopilot looks
// even if a frame reads aimAngle before the mouse.
function aimAt(G, x, y) {
  const p = G.player;
  const ai = G.autoInput;
  if (!p || !ai) return;
  const cam = G.camera || { x: p.x - 640, y: p.y - 400 };
  ai.mouseX = x - cam.x;
  ai.mouseY = y - cam.y;
  p.aimAngle = angleTo(p.x, p.y, x, y);
}

// Press one key for exactly this frame (held key + edge flag).
function pressKey(G, code) {
  const ai = G.autoInput;
  if (!ai) return;
  ai.keys.add(code);
  if (ai.pressed) ai.pressed.add(code);
}

// The accept action (spec 9.1a): pulse E for exactly one frame. main.js
// swaps G.input to G.autoInput after updateAutopilot runs, so the
// mission dialog branch (which reads G.input) sees this E and accepts.
export function autopilotAcceptDialog(G) {
  ensureAutopilotState(G);
  const ai = G.autoInput;
  ai.interactPressed = true;
  pressKey(G, 'KeyE');
  return true;
}

// Pulse E to enter / exit a car (player.js handleInteract reads the
// same edge from the swapped input).
function pulseInteract(G) {
  return autopilotAcceptDialog(G);
}

// Movement keys for a desired direction: WASD from the direction vector,
// Shift to sprint when the target is far.
function setMoveKeys(G, dx, dy, sprint) {
  const ai = G.autoInput;
  if (!ai) return;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  if (nx > 0.25) ai.keys.add('KeyD');
  if (nx < -0.25) ai.keys.add('KeyA');
  if (ny > 0.25) ai.keys.add('KeyS');
  if (ny < -0.25) ai.keys.add('KeyW');
  if (sprint) ai.keys.add('ShiftLeft');
}

// Grid router (first junction first, then Manhattan along junctions,
// then the exact target — never a diagonal cut across a block).
export function findRouteGrid(x1, y1, x2, y2) {
  const nearest = (v) => {
    let best = ROADS[0];
    for (const r of ROADS) if (Math.abs(r - v) < Math.abs(best - v)) best = r;
    return best;
  };
  const start = { x: nearest(x1), y: nearest(y1) };
  const end = { x: nearest(x2), y: nearest(y2) };
  const pts = [{ x: start.x, y: start.y }];
  let cx = start.x;
  let cy = start.y;
  while (cx !== end.x) {
    cx += Math.sign(end.x - cx) * 400;
    pts.push({ x: cx, y: cy });
  }
  while (cy !== end.y) {
    cy += Math.sign(end.y - cy) * 400;
    pts.push({ x: cx, y: cy });
  }
  pts.push({ x: x2, y: y2 });
  return pts;
}

function nearestRoadPointOf(G, x, y) {
  if (G.world && typeof G.world.nearestRoadPoint === 'function') {
    return G.world.nearestRoadPoint(x, y);
  }
  return nearestRoadPoint(G, x, y);
}

function routeFor(G, x1, y1, x2, y2) {
  if (G.world && typeof G.world.findRoute === 'function') {
    const r = G.world.findRoute(x1, y1, x2, y2);
    if (Array.isArray(r) && r.length > 0) return r;
  }
  return findRouteGrid(x1, y1, x2, y2);
}

function landmarkOf(G, key, fallback) {
  const w = G.world || {};
  if (w[key] && typeof w[key].x === 'number') return { x: w[key].x, y: w[key].y };
  if (LANDMARKS[key]) return { x: LANDMARKS[key].x, y: LANDMARKS[key].y };
  return fallback || { x: 600, y: 600 };
}

// Fastest parked car near (x, y) that beats currentTop by at least the
// minimum gain. The courier and wrecked cars never count; the car just
// abandoned is excluded until its cooldown lapses (v2 lesson 20: never
// walk back into the slow car just left).
function findFasterParkedCar(G, x, y, currentTop, range) {
  const st = ensureAutopilotState(G);
  const now = (G.time && G.time.t) || 0;
  let best = null;
  let bestTop = currentTop + AUTOPILOT_SWITCH_MIN_GAIN;
  for (const car of G.cars || []) {
    if (!car || car.wrecked || car.id === 'courier' || car.kind === 'courier') continue;
    if (!car.parked) continue;
    if (car.id === st.abandonedCarId && now < st.abandonedUntil) continue;
    const d = dist(x, y, car.x, car.y);
    if (d > range) continue;
    const top = effectiveTopSpeed(car);
    if (top >= bestTop) {
      best = car;
      bestTop = top;
    }
  }
  return best;
}

// Nearest parked car of any speed (fallback when nothing fast is near).
function nearestParkedCar(G, x, y, range) {
  const st = ensureAutopilotState(G);
  const now = (G.time && G.time.t) || 0;
  let best = null;
  let bestD = range;
  for (const car of G.cars || []) {
    if (!car || car.wrecked || car.id === 'courier' || car.kind === 'courier') continue;
    if (!car.parked) continue;
    if (car.id === st.abandonedCarId && now < st.abandonedUntil) continue;
    const d = dist(x, y, car.x, car.y);
    if (d < bestD) {
      best = car;
      bestD = d;
    }
  }
  return best;
}

// Walk on foot toward (tx, ty). Road-graph routing with a memoized
// target (recompute only when the target moved >120); the final leg is
// walked straight. Direct mode skips the graph (shootouts: walk
// straight at the enemy). Returns the distance left to the target.
function walkToTarget(G, dt, tx, ty, direct) {
  const st = ensureAutopilotState(G);
  const p = G.player;
  if (!p) return Infinity;
  const target = { x: tx, y: ty };
  const remaining = dist(p.x, p.y, tx, ty);
  if (remaining < 30) return remaining;
  if (direct) {
    setMoveKeys(G, tx - p.x, ty - p.y, remaining > 120);
    st.walkDirect = true;
    return remaining;
  }
  // Recompute the memoized route only when the target moved >120.
  if (!st.walkRoute || !st.walkTargetFor
    || dist(tx, ty, st.walkTargetFor.x, st.walkTargetFor.y) > AUTOPILOT_WALK_RECOMPUTE
    || st.walkDirect) {
    const rp = nearestRoadPointOf(G, tx, ty);
    const leg = routeFor(G, p.x, p.y, rp.x, rp.y);
    const start = nearestRoadPointOf(G, p.x, p.y);
    const route = [start];
    for (const pt of leg) {
      const last = route[route.length - 1];
      if (dist(pt.x, pt.y, last.x, last.y) > 1) route.push({ x: pt.x, y: pt.y });
    }
    route.push({ x: tx, y: ty });
    st.walkRoute = route;
    st.walkRouteIndex = 0;
    st.walkTargetFor = target;
    st.walkDirect = false;
  }
  const route = st.walkRoute;
  let idx = Math.min(st.walkRouteIndex, route.length - 1);
  let wp = route[idx];
  if (dist(p.x, p.y, wp.x, wp.y) < 28 && idx < route.length - 1) {
    st.walkRouteIndex += 1;
    idx = Math.min(st.walkRouteIndex, route.length - 1);
    wp = route[idx];
  }
  setMoveKeys(G, wp.x - p.x, wp.y - p.y, remaining > 120);
  return remaining;
}

// Drive the player's car toward a static point (route + driveRoute),
// or walk there when on foot (find a car first). Returns 'driving' |
// 'arrived' | 'walking' | 'entering' | 'switching' | 'nocar'.
export function autopilotDriveTo(G, dt, tx, ty, cruise, opts) {
  const st = ensureAutopilotState(G);
  const step = (typeof dt === 'number' && dt > 0) ? dt : 1 / 60;
  const p = G.player;
  if (!p) return 'nocar';
  const chase = !!(opts && opts.chase);
  const speedLimit = chase ? AUTOPILOT_SWITCH_CHASE_SPEED : AUTOPILOT_SWITCH_GOTO_SPEED;
  const switchRange = chase ? AUTOPILOT_SWITCH_CHASE_RANGE : AUTOPILOT_SWITCH_GOTO_RANGE;
  const wantCruise = cruise || (chase ? AUTOPILOT_CHASE_CRUISE : AUTOPILOT_GOTO_CRUISE);
  const now = (G.time && G.time.t) || 0;

  if (!p.onFoot && p.car) {
    const car = p.car;
    // Leave a slow car for a much faster parked car nearby — never for
    // a marginal gain, and never inside the garage zone (E there opens
    // the garage menu instead of exiting the car).
    const zone = garageZone(G);
    const inGarageZone = dist(car.x, car.y, zone.x, zone.y) < zone.r + 20;
    if (!inGarageZone && effectiveTopSpeed(car) < speedLimit) {
      const faster = findFasterParkedCar(G, car.x, car.y, effectiveTopSpeed(car), switchRange);
      if (faster) {
        st.targetCar = faster;
        st.abandonedCarId = car.id;
        st.abandonedUntil = now + 3;
        pulseInteract(G);
        return 'switching';
      }
    }
    // Rebuild the route only when the destination drifted >100.
    if (!car.route || !car.routeDest || dist(tx, ty, car.routeDest.x, car.routeDest.y) > 100) {
      routeCarTo(G, car, tx, ty);
    }
    driveRoute(G, car, step, wantCruise);
    G.autopilotDrove = true;
    p.x = car.x;
    p.y = car.y;
    p.angle = car.angle;
    p.speed = Math.abs(car.speed || 0);
    if (dist(car.x, car.y, tx, ty) < 60) return 'arrived';
    return 'driving';
  }

  // On foot: walk to the chosen car and enter it, or find one first.
  if (st.targetCar && !st.targetCar.wrecked) {
    const c = st.targetCar;
    const d = dist(p.x, p.y, c.x, c.y);
    if (d < AUTOPILOT_ENTER_RANGE) {
      pulseInteract(G);
      st.targetCar = null;
      return 'entering';
    }
    walkToTarget(G, step, c.x, c.y, false);
    return 'walking';
  }
  st.targetCar = null;
  // Prefer a FAST parked car, fall back to the nearest parked car (v2
  // lesson 20: never pick the nearest car blindly — that is the slow
  // car just abandoned). If none is near, walk to the target itself.
  const fast = findFasterParkedCar(G, p.x, p.y, 420, AUTOPILOT_CAR_SEARCH_RANGE);
  const car = fast || nearestParkedCar(G, p.x, p.y, AUTOPILOT_CAR_SEARCH_RANGE);
  if (car) {
    st.targetCar = car;
    walkToTarget(G, step, car.x, car.y, false);
    return 'walking';
  }
  walkToTarget(G, step, tx, ty, false);
  return 'walking';
}

// Chase the courier (m2): cruise 520 against the courier's 380, ram
// inside 70 while faster than 120 (missions.js counts the hit and cuts
// the courier's cruise to 55% each time). On foot, walk to the
// courier's nearest ROAD point — never at the moving courier itself.
export function autopilotChase(G, dt) {
  const st = ensureAutopilotState(G);
  const p = G.player;
  const courier = G.mission && G.mission.data ? G.mission.data.courier : null;
  if (!p || !courier) return 'nocourier';
  if (p.onFoot) {
    const rp = m2OnFootTarget(G) || nearestRoadPointOf(G, courier.x, courier.y);
    return autopilotDriveTo(G, dt, rp.x, rp.y, AUTOPILOT_CHASE_CRUISE, { chase: true });
  }
  const car = p.car;
  const d = dist(car.x, car.y, courier.x, courier.y);
  // Car switch, chase thresholds: a slow car can never catch 380.
  const zone = garageZone(G);
  const inGarageZone = dist(car.x, car.y, zone.x, zone.y) < zone.r + 20;
  if (!inGarageZone && effectiveTopSpeed(car) < AUTOPILOT_SWITCH_CHASE_SPEED) {
    const faster = findFasterParkedCar(G, car.x, car.y, effectiveTopSpeed(car), AUTOPILOT_SWITCH_CHASE_RANGE);
    if (faster) {
      st.targetCar = faster;
      st.abandonedCarId = car.id;
      st.abandonedUntil = ((G.time && G.time.t) || 0) + 3;
      pulseInteract(G);
      return 'switching';
    }
  }
  // Ram reset: touching the courier too slowly to count a hit (a hit
  // needs speed > 120) leaves both cars at the same point, where the
  // steering target has zero length and the car spins in place
  // forever. Back off to a run-up point on the road, then charge again.
  const startRamReset = () => {
    let ax = car.x - courier.x;
    let ay = car.y - courier.y;
    const al = Math.hypot(ax, ay);
    if (al < 5) {
      ax = -Math.cos(car.angle);
      ay = -Math.sin(car.angle);
    } else {
      ax /= al;
      ay /= al;
    }
    st.ramResetTarget = nearestRoadPointOf(G, car.x + ax * 260, car.y + ay * 260);
    st.ramReset = true;
    routeCarTo(G, car, st.ramResetTarget.x, st.ramResetTarget.y);
  };
  if (st.ramReset) {
    const rd = dist(car.x, car.y, st.ramResetTarget.x, st.ramResetTarget.y);
    if (d > 220 || rd < 60) {
      st.ramReset = false;
    } else {
      if (!car.route || !car.routeDest
        || dist(st.ramResetTarget.x, st.ramResetTarget.y, car.routeDest.x, car.routeDest.y) > 100) {
        routeCarTo(G, car, st.ramResetTarget.x, st.ramResetTarget.y);
      }
      driveRoute(G, car, dt, 300);
      G.autopilotDrove = true;
      p.x = car.x;
      p.y = car.y;
      p.angle = car.angle;
      p.speed = Math.abs(car.speed || 0);
      return 'resetting';
    }
  }
  if (d < 90 && Math.abs(car.speed || 0) < 120) {
    startRamReset();
    driveRoute(G, car, dt, 300);
    G.autopilotDrove = true;
    p.x = car.x;
    p.y = car.y;
    p.angle = car.angle;
    p.speed = Math.abs(car.speed || 0);
    return 'resetting';
  }
  if (d < 250 && d >= 30) {
    // Ramming line: straight at the courier, full cruise.
    driveCarToward(G, car, courier.x, courier.y, dt, AUTOPILOT_CHASE_CRUISE);
  } else if (d < 30) {
    // Too close to steer at (zero-length target): back off instead.
    startRamReset();
    driveRoute(G, car, dt, 300);
    G.autopilotDrove = true;
    p.x = car.x;
    p.y = car.y;
    p.angle = car.angle;
    p.speed = Math.abs(car.speed || 0);
    return 'resetting';
  } else {
    // Route to the courier's nearest road point; repath only when the
    // courier moved >100 from the route's recorded destination.
    const rp = nearestRoadPointOf(G, courier.x, courier.y);
    if (!car.route || !car.routeDest || dist(rp.x, rp.y, car.routeDest.x, car.routeDest.y) > 100) {
      routeCarTo(G, car, rp.x, rp.y);
    }
    driveRoute(G, car, dt, AUTOPILOT_CHASE_CRUISE);
  }
  G.autopilotDrove = true;
  p.x = car.x;
  p.y = car.y;
  p.angle = car.angle;
  p.speed = Math.abs(car.speed || 0);
  return 'chasing';
}

// Shootout step (m8 / m10 / m12 stage 0): walk straight to the nearest
// enemy until in range, shoot in aimed bursts every 0.45s (never
// spray), pick up arena ammo at ammo <= 6, pick up a better weapon
// crate when one is in the arena. Returns 'fighting' | 'clear' |
// 'driving' | 'exiting' | 'entering'.
function shootoutStep(G, dt, arena) {
  const st = ensureAutopilotState(G);
  const p = G.player;
  if (!p) return 'noplayer';
  const shootKey = `${G.mission ? G.mission.id : ''}:${G.mission ? G.mission.stage : ''}`;
  if (st.lastShootKey !== shootKey) {
    st.lastShootKey = shootKey;
    st.weaponChosen = false;
    st.shootTimer = 0;
    st.burstHold = 0;
  }
  // Drive to the arena edge, then get out and fight on foot.
  if (!p.onFoot && p.car) {
    const d = dist(p.car.x, p.car.y, arena.x, arena.y);
    if (d > 150) {
      autopilotDriveTo(G, dt, arena.x, arena.y, AUTOPILOT_GOTO_CRUISE, {});
      return 'driving';
    }
    pulseInteract(G);
    return 'exiting';
  }
  // On foot and far from the arena: DRIVE there first (autopilotDriveTo
  // finds a car). Walking the whole way meets the advancing enemies in
  // the street, burns all ammo at moving targets, and strands Rook.
  // Batch-3 fix, live m10 probe 22 Nov: on-foot start at spawn, 5
  // enemies met mid-city, ammo 0 with 1 kill in 300s.
  if (p.onFoot && dist(p.x, p.y, arena.x, arena.y) > 450) {
    autopilotDriveTo(G, dt, arena.x, arena.y, AUTOPILOT_GOTO_CRUISE, {});
    return 'driving';
  }
  if (p.onFoot && st.targetCar) st.targetCar = null;
  const live = (G.enemies || []).filter((e) => !e.dead && e.hp > 0);
  if (live.length === 0) return 'clear';
  // Best weapon first: an SMG or shotgun beats the pistol.
  if (!st.weaponChosen) {
    const owned = (G.weapons && G.weapons.owned) || {};
    if (owned.smg) selectWeapon(G, 'smg');
    else if (owned.shotgun) selectWeapon(G, 'shotgun');
    st.weaponChosen = true;
  }
  const arenaR = 450;
  // Hurt? Walk to a health pickup in the arena first — or one dropped
  // near Rook (a dead enemy's drop counts even outside the arena).
  if ((p.health ?? 100) < AUTOPILOT_HEALTH_PICKUP_BELOW) {
    let best = null;
    let bestD = arenaR;
    for (const pk of G.pickups || []) {
      if (pk.kind !== 'health') continue;
      const d = dist(p.x, p.y, pk.x, pk.y);
      if (d < bestD && (dist(pk.x, pk.y, arena.x, arena.y) < arenaR || d < 300)) {
        best = pk;
        bestD = d;
      }
    }
    if (best) {
      walkToTarget(G, dt, best.x, best.y, true);
      return 'seeking-health';
    }
  }
  // Pistol in hand and a better weapon crate in the arena — or near
  // Rook? Grab it.
  const def = currentWeaponDef(G);
  if (def && def.id === 'pistol') {
    let best = null;
    let bestD = arenaR;
    for (const c of G.crates || []) {
      if (c.taken || (c.kind !== 'smg' && c.kind !== 'shotgun')) continue;
      const d = dist(p.x, p.y, c.x, c.y);
      if (d < bestD && (dist(c.x, c.y, arena.x, arena.y) < arenaR || d < 300)) {
        best = c;
        bestD = d;
      }
    }
    if (best) {
      walkToTarget(G, dt, best.x, best.y, true);
      aimAt(G, best.x, best.y);
      return 'seeking-crate';
    }
  }
  // Low ammo? Walk to the nearest arena ammo pickup — or one dropped
  // near Rook.
  if (currentAmmo(G) <= AUTOPILOT_AMMO_PICKUP_AT) {
    let best = null;
    let bestD = arenaR;
    for (const pk of G.pickups || []) {
      if (pk.kind !== 'ammo') continue;
      const d = dist(p.x, p.y, pk.x, pk.y);
      if (d < bestD && (dist(pk.x, pk.y, arena.x, arena.y) < arenaR || d < 300)) {
        best = pk;
        bestD = d;
      }
    }
    if (best) {
      walkToTarget(G, dt, best.x, best.y, true);
      aimAt(G, best.x, best.y);
      return 'seeking-ammo';
    }
  }
  // Walk straight to the nearest enemy until in range, then fire in
  // aimed bursts every 0.45s. A burst is one aimed shot for the pistol
  // / shotgun, and a 3-shot burst for the SMG (trigger held 0.25s at
  // its 0.08s fire interval) — never spray.
  let enemy = null;
  let enemyD = Infinity;
  for (const e of live) {
    const d = dist(p.x, p.y, e.x, e.y);
    if (d < enemyD) {
      enemy = e;
      enemyD = d;
    }
  }
  if (!enemy) return 'clear';
  const range = (AUTOPILOT_SHOOT_RANGE[def ? def.id : 'pistol'] || 300);
  aimAt(G, enemy.x, enemy.y);
  if (enemyD > range) {
    walkToTarget(G, dt, enemy.x, enemy.y, true);
    return 'closing';
  }
  const ai = G.autoInput;
  if (st.burstHold > 0) {
    // Mid-burst: keep the trigger held until the burst window ends.
    ai.mouseDown = true;
    st.burstHold -= dt;
    if (st.burstHold <= 0) st.shootTimer = AUTOPILOT_SHOOT_BURST_INTERVAL;
    return 'firing';
  }
  st.shootTimer -= dt;
  if (st.shootTimer <= 0) {
    ai.mouseDown = true;
    ai.justClicked = true;
    st.burstHold = (def && def.id === 'smg') ? 0.25 : 0.05;
  }
  return 'firing';
}

// The m11 garage step: drive to the Fixer Garage, open the menu, buy
// the cheapest available upgrade, close, continue. The open + buy +
// close all happen inside this one call (see the deadlock note at the
// top of this file): main.js never runs stepGame while the menu is open,
// so waiting a frame between open and buy would stall forever.
function garageStep(G, dt) {
  const st = ensureAutopilotState(G);
  const p = G.player;
  if (!p) return 'noplayer';
  const zone = garageZone(G);
  const pos = playerPos(G);
  if (dist(pos.x, pos.y, zone.x, zone.y) > zone.r + 20) {
    st.garageStep = 'drive';
    autopilotDriveTo(G, dt, zone.x, zone.y, AUTOPILOT_GOTO_CRUISE, {});
    return 'driving';
  }
  if (p.onFoot) {
    // Need a car to buy upgrades for: find one and drive in.
    autopilotDriveTo(G, dt, zone.x, zone.y, AUTOPILOT_GOTO_CRUISE, {});
    return 'nocar';
  }
  const cheapest = cheapestAvailableUpgrade(G);
  if (!cheapest) return 'nomore';
  st.garageStep = 'buy';
  if (!openGarage(G)) return 'noopen';
  const bought = buyUpgrade(G, cheapest.kind);
  closeGarage(G);
  st.garageStep = bought ? 'done' : 'nocash';
  return bought ? 'bought' : 'nocash';
}

// Pick the autopilot's target for the current mission stage and act.
function runMission(G, dt) {
  const m = G.mission;
  const d = m.data || {};
  const id = m.id;
  const spray = landmarkOf(G, 'sprayShop', { x: 1000, y: 2600 });
  const hideout = landmarkOf(G, 'hideout', { x: 600, y: 600 });
  switch (id) {
    case 'm1':
    case 'm4':
    case 'm5':
      return autopilotDriveTo(G, dt, ...(m.stage === 0
        ? [d.pickup.x, d.pickup.y] : [d.drop.x, d.drop.y]),
      AUTOPILOT_GOTO_CRUISE, {});
    case 'm2':
      return autopilotChase(G, dt);
    case 'm3': {
      const cp = d.checkpoints && d.checkpoints[d.checkpointIndex || 0];
      if (!cp) return 'done';
      return autopilotDriveTo(G, dt, cp.x, cp.y, AUTOPILOT_TIMED_CRUISE, {});
    }
    case 'm6': {
      const left = (G.pickups || []).filter((pk) => pk.mission === 'm6');
      if (m.stage === 0 && left.length > 0) {
        let best = left[0];
        let bestD = Infinity;
        const pos = playerPos(G);
        for (const pk of left) {
          const dd = dist(pos.x, pos.y, pk.x, pk.y);
          if (dd < bestD) {
            best = pk;
            bestD = dd;
          }
        }
        return autopilotDriveTo(G, dt, best.x, best.y, AUTOPILOT_GOTO_CRUISE, {});
      }
      return autopilotDriveTo(G, dt, d.drop.x, d.drop.y, AUTOPILOT_GOTO_CRUISE, {});
    }
    case 'm7':
      if (m.stage === 0) return autopilotDriveTo(G, dt, d.dest.x, d.dest.y, AUTOPILOT_TIMED_CRUISE, {});
      // Escape: drive to the Spray Shop until the stars hit zero.
      return autopilotDriveTo(G, dt, spray.x, spray.y, AUTOPILOT_TIMED_CRUISE, {});
    case 'm8':
      if (m.stage === 0) return shootoutStep(G, dt, d.arena || hideout);
      return autopilotDriveTo(G, dt, hideout.x, hideout.y, AUTOPILOT_TIMED_CRUISE, {});
    case 'm9':
      // Helicopter overhead: ignore it except by never stopping under
      // the spotlight — keep driving toward the objective.
      return autopilotDriveTo(G, dt, d.dest.x, d.dest.y, AUTOPILOT_TIMED_CRUISE, {});
    case 'm10':
      if (m.stage === 0) return shootoutStep(G, dt, d.arena || landmarkOf(G, 'docks', { x: 2600, y: 2600 }));
      return autopilotDriveTo(G, dt, d.exit.x, d.exit.y, AUTOPILOT_TIMED_CRUISE, {});
    case 'm11':
      if (m.stage === 0) return garageStep(G, dt);
      {
        const cp = d.checkpoints && d.checkpoints[d.checkpointIndex || 0];
        if (!cp) return 'done';
        return autopilotDriveTo(G, dt, cp.x, cp.y, AUTOPILOT_TIMED_CRUISE, {});
      }
    case 'm12':
      if (m.stage === 0) return shootoutStep(G, dt, d.arena || landmarkOf(G, 'bank', { x: 1800, y: 1400 }));
      if (m.stage === 1) return autopilotDriveTo(G, dt, d.loot.x, d.loot.y, AUTOPILOT_GOTO_CRUISE, {});
      if (m.stage === 2) return autopilotDriveTo(G, dt, d.escape.x, d.escape.y, AUTOPILOT_TIMED_CRUISE, {});
      return autopilotDriveTo(G, dt, d.plane.x, d.plane.y, AUTOPILOT_TIMED_CRUISE, {});
    default:
      return 'idle';
  }
}

// One autopilot frame. main.js calls this BEFORE the dialog branch, so
// the E pulse below reaches the mission dialog (spec 9.1a). The
// autopilot resets its per-frame output first: keys are rebuilt fresh
// every frame and edge flags live for exactly one frame.
export function updateAutopilot(G, dt) {
  const st = ensureAutopilotState(G);
  G.autopilotActive = st.enabled;
  if (!st.enabled) {
    G.autopilotDrove = false;
    return;
  }
  if (G.state && G.state !== 'playing') {
    G.autopilotActive = false;
    G.autopilotDrove = false;
    return;
  }
  const step = (typeof dt === 'number' && dt > 0) ? dt : 1 / 60;
  // Fresh per-frame output: no key or edge can stick across frames.
  G.autopilotDrove = false;
  const ai = G.autoInput;
  ai.keys.clear();
  if (ai.pressed) ai.pressed.clear();
  ai.mouseDown = false;
  ai.justClicked = false;
  ai.interactPressed = false;

  // Mission dialog open: press E to accept (the accept action). This
  // runs before any car search, so the m2 freeze can never happen.
  if (G.mission && G.mission.dialogOpen) {
    st.mode = 'dialog';
    autopilotAcceptDialog(G);
    return;
  }
  // Safety net: a garage menu left open (by a human, or by a future
  // main.js that runs the autopilot while paused) — buy for m11, then
  // close it. The normal m11 path never leaves the menu open (see
  // garageStep: open + buy + close in one call).
  if (G.garage && G.garage.open) {
    st.mode = 'garage-menu';
    if (G.mission && G.mission.id === 'm11' && G.mission.stage === 0) {
      const cheapest = cheapestAvailableUpgrade(G);
      if (cheapest) buyUpgrade(G, cheapest.kind);
    }
    closeGarage(G);
    return;
  }

  const m = G.mission;
  if (m && m.state === 'active' && m.id) {
    st.mode = m.id;
    runMission(G, step);
    return;
  }
  // Failed mission: drive back to the Fixer Garage to re-trigger it
  // (it restarts from stage 0 — m12 from stage (a)).
  if (m && m.state === 'failed') {
    st.mode = 'retry';
    const zone = garageZone(G);
    autopilotDriveTo(G, dt, zone.x, zone.y, AUTOPILOT_GOTO_CRUISE, {});
    return;
  }
  // No mission: drive to the Fixer Garage so the next one is offered
  // (auto-offer radius 50). Nothing to do once the arc is complete.
  const completed = (m && Array.isArray(m.completed)) ? m.completed : [];
  if (completed.length < 12) {
    st.mode = 'goto-garage';
    const zone = garageZone(G);
    autopilotDriveTo(G, dt, zone.x, zone.y, AUTOPILOT_GOTO_CRUISE, {});
    return;
  }
  st.mode = 'idle';
}
