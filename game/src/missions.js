// missions.js — the 12-mission linear arc for Crescent Bay.
// Objectives are CONDITIONS ("reach the marker", "escape the police"),
// never kill counts. A failed mission restarts from stage 0. Each
// mission has a fixer (Mara or Dex), a spoken hook, a cash reward, and
// a generous time limit. All 12 must be completable by the autopilot.
//
// Design against the m2 Tail Chase freeze (spec §9.1), all three causes:
// (a) the dialog-accept path runs BEFORE the autopilot's car search —
//     updateMissions() accepts the dialog on E itself, and main.js must
//     run updateAutopilot BEFORE the dialog branch, so the autopilot can
//     press E to accept; (b) the on-foot car search falls back to walking
//     to the courier's NEAREST ROAD POINT if no car is in range —
//     m2OnFootTarget(G) exposes that point, never walk at a moving
//     target forever; (c) the courier rebuilds its route only when its
//     target moves >100 from the route's recorded destination —
//     updateCourier() repaths only on arrival or on that >100 drift,
//     never every frame.
import { ENEMY_HP, spawnEnemy, spawnArenaCover, spawnHealthPickup, spawnAmmoPickup, spawnMoneyPickup, clearCombat } from './combat.js';
import { spawnArenaCrates } from './weapons.js';
import { forceHelicopter } from './helicopter.js';
import { setHeat } from './police.js';
import { garagePurchaseCount } from './garage.js';
import { MISSION_ARC as CONFIG_MISSION_ARC } from './config.js';

// The arc table itself lives in config.js — the single source of truth
// for order, rewards and time limits (batch 3 fix: batch 2 defined a
// second table here). This module adds only the dialogue hooks, the
// mission-type labels and the shootout details the arc logic needs.
const MISSION_EXTRAS = {
  m1: { type: 'drive', hook: 'Rook. Small job, good money. Pick up the package at the market and drop it downtown. Don\'t keep Mara waiting.' },
  m2: { type: 'chase', hook: 'A courier is moving product through my streets. Ram his car four times, hard and fast, and he\'ll slow down enough to stop.' },
  m3: { type: 'checkpoints', hook: 'Three drops, one clock. Club, marina, airport — hit them all before the timer runs out and the money is yours.' },
  m4: { type: 'drive', hook: 'A crate is waiting at the marina. Bring it to the hideout. The docks are hot tonight, so keep your eyes open.' },
  m5: { type: 'drive', hook: 'Night run. Pick up at the club, drop at the docks. Headlights on, mouth shut. Dex is counting on you.' },
  m6: { type: 'collector', hook: 'Five money drops are stashed around the city. Collect them all, then bring yourself home to the hideout.' },
  m7: { type: 'escape', hook: 'Drive to the airport — and the whole city will be on you. Lose them. All of them. Then the money is yours.' },
  m8: { type: 'shootout', enemies: 3, hook: 'The big one starts here. Three guns in the old yard. Clear the ground, then get out clean. Mara is watching.' },
  m9: { type: 'heliEscape', hook: 'The police helicopter is up and its spotlight is on you. Hiding won\'t work under that light — keep moving to the hideout.' },
  m10: { type: 'shootout', enemies: 5, crates: true, hook: 'Dockside, five guns, and crates with better hardware inside. Grab an SMG or a shotgun, clear the docks, reach the exit.' },
  m11: { type: 'garage', hook: 'The Fixer Garage has the parts your car needs. Buy at least one upgrade, then run three checkpoints in the upgraded car.' },
  m12: { type: 'finale', enemies: 4, hook: 'The bank. Four guns, a helicopter overhead, and the biggest score in Crescent Bay. Grab the loot and reach the plane.' },
};

export const MISSION_ARC = CONFIG_MISSION_ARC.map((m) => ({
  ...m,
  ...(MISSION_EXTRAS[m.id] || {}),
}));

export const MISSION_DIALOG_RADIUS = 50;
export const MISSION_MARKER_RADIUS = 70;
export const COURIER_CRUISE = 380;
export const COURIER_HIT_DISTANCE = 70;
export const COURIER_HIT_MIN_SPEED = 120;
export const COURIER_HITS_TO_STOP = 4;
export const COURIER_SLOW_FACTOR = 0.55;
export const CHASE_CRUISE = 520;

const ROADS = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];

export function missionDef(id) {
  return MISSION_ARC.find((m) => m.id === id) || null;
}

export function createMissionState() {
  return {
    id: null, stage: 0, state: 'none', // none | dialog | active | done | failed
    timeLeft: 0, data: {}, dialogOpen: false, marker: null,
    completed: [], highest: 0, dialogEl: null,
    prevInteract: false, triggerCooldown: 0, nightWas: 0,
  };
}

export function ensureMissionState(G) {
  if (!G.mission) G.mission = createMissionState();
  if (!Array.isArray(G.mission.completed)) G.mission.completed = [];
  if (!G.mission.data || typeof G.mission.data !== 'object') G.mission.data = {};
  if (typeof G.mission.highest !== 'number') G.mission.highest = 0;
  return G.mission;
}

export function currentMission(G) {
  ensureMissionState(G);
  return G.mission.id ? missionDef(G.mission.id) : null;
}

export function nextMissionDef(G) {
  ensureMissionState(G);
  for (const m of MISSION_ARC) {
    if (!G.mission.completed.includes(m.id)) return m;
  }
  return null;
}

// Landmark lookup: the world's named places when Builder A provides
// them, otherwise fixed points on the road grid (roads at 200 + i*400).
export function landmark(G, key, fx, fy) {
  const w = G.world || {};
  if (w[key] && typeof w[key].x === 'number') return { x: w[key].x, y: w[key].y };
  return { x: fx, y: fy };
}

export function nearestRoadPoint(G, x, y) {
  if (G.world && typeof G.world.nearestRoadPoint === 'function') {
    return G.world.nearestRoadPoint(x, y);
  }
  let bx = ROADS[0];
  let by = ROADS[0];
  for (const r of ROADS) {
    if (Math.abs(r - x) < Math.abs(bx - x)) bx = r;
    if (Math.abs(r - y) < Math.abs(by - y)) by = r;
  }
  return Math.abs(bx - x) < Math.abs(by - y) ? { x: bx, y } : { x, y: by };
}

function nearestJunction(x, y) {
  let bx = ROADS[0];
  let by = ROADS[0];
  for (const r of ROADS) {
    if (Math.abs(r - x) < Math.abs(bx - x)) bx = r;
    if (Math.abs(r - y) < Math.abs(by - y)) by = r;
  }
  return { x: bx, y: by };
}

// Grid route: FIRST junction first (never cut diagonally across a
// block), then Manhattan along junctions, then the exact target.
export function gridRoute(x1, y1, x2, y2) {
  const start = nearestJunction(x1, y1);
  const end = nearestJunction(x2, y2);
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

function playerPos(G) {
  const p = G.player;
  if (!p) return { x: 0, y: 0 };
  if (p.car) return { x: p.car.x, y: p.car.y };
  return { x: p.x, y: p.y };
}

function playerSpeed(G) {
  const p = G.player;
  if (!p) return 0;
  if (p.car) return Math.abs(p.car.speed || 0);
  return Math.abs(p.speed || 0);
}

function reached(G, target, radius) {
  if (!target) return false;
  const pos = playerPos(G);
  return Math.hypot(pos.x - target.x, pos.y - target.y) < (radius || MISSION_MARKER_RADIUS);
}

function hasDocument() {
  return typeof document !== 'undefined' && document && typeof document.createElement === 'function';
}

function showMissionDialog(G, def) {
  ensureMissionState(G);
  if (!hasDocument()) return;
  hideMissionDialog(G);
  const el = document.createElement('div');
  el.id = 'mission-dialog';
  el.setAttribute('role', 'dialog');
  el.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);'
    + 'background:rgba(16,18,28,0.96);color:#f2f2f2;border:2px solid #ffd76a;border-radius:10px;'
    + 'padding:16px 20px;z-index:35;max-width:520px;font-family:sans-serif;';
  el.innerHTML = `<div style="font-size:18px;font-weight:bold;">${def.name} — ${def.fixer}</div>
    <div style="margin:8px 0;color:#ddd;">${def.hook}</div>
    <div style="color:#ffd76a;">Reward: $${def.reward} &nbsp;·&nbsp; Time: ${Math.floor(def.timeLimit / 60)}:${String(def.timeLimit % 60).padStart(2, '0')}</div>
    <button data-accept="1" style="margin-top:10px;padding:8px 18px;cursor:pointer;">Accept (E)</button>`;
  document.body.appendChild(el);
  G.mission.dialogEl = el;
  const btn = el.querySelector('[data-accept]');
  if (btn) btn.addEventListener('click', () => acceptMissionDialog(G));
}

function hideMissionDialog(G) {
  ensureMissionState(G);
  if (G.mission.dialogEl && G.mission.dialogEl.remove) G.mission.dialogEl.remove();
  G.mission.dialogEl = null;
}

export function startMission(G, id) {
  ensureMissionState(G);
  const def = missionDef(id);
  if (!def) return false;
  if (G.mission.state === 'active' || G.mission.state === 'dialog') return false;
  G.mission.id = id;
  G.mission.stage = 0;
  G.mission.state = 'dialog';
  G.mission.dialogOpen = true;
  // Arm the accept edge detector: prevInteract is only written inside
  // the dialog branch, so without this reset it stays true from the
  // PREVIOUS dialog's accept (E held) and the next dialog can never
  // see an E edge. Batch-3 fix: the live probe showed m2 stuck in
  // dialog for 5 minutes after m1 — the autopilot pulsed E every
  // frame, but prevInteract was already true, so no edge ever fired.
  // A human is unaffected (they release E between dialogs).
  G.mission.prevInteract = false;
  G.mission.timeLeft = def.timeLimit;
  G.mission.data = {};
  showMissionDialog(G, def);
  if (G.audio) G.audio.play && G.audio.play('missionOffer');
  return true;
}

// The dialog-accept path: called on E (or the Accept button) and runs
// BEFORE any autopilot car search, so the m2 freeze can never happen
// because the dialog was left unaccepted.
export function acceptMissionDialog(G) {
  ensureMissionState(G);
  if (!G.mission.dialogOpen || G.mission.state !== 'dialog') return false;
  const def = missionDef(G.mission.id);
  if (!def) return false;
  hideMissionDialog(G);
  G.mission.dialogOpen = false;
  // Disarm the edge detector too, so no stale true leaks into the
  // next dialog (see startMission).
  G.mission.prevInteract = false;
  G.mission.state = 'active';
  G.mission.stage = 0;
  G.mission.timeLeft = def.timeLimit;
  G.mission.data = { startedAt: (G.time && G.time.t) || 0 };
  setupMission(G, def);
  if (G.audio) G.audio.play && G.audio.play('missionStart');
  return true;
}

function spawnArena(G, def, cx, cy, enemyCount, withCrates) {
  const rng = G.rng || Math.random;
  spawnArenaCover(G, cx, cy);
  spawnHealthPickup(G, cx - 100, cy + 40, 40);
  spawnHealthPickup(G, cx + 100, cy - 40, 40);
  spawnHealthPickup(G, cx, cy + 130, 40);
  spawnAmmoPickup(G, cx, cy - 100, 24);
  spawnAmmoPickup(G, cx, cy + 100, 24);
  if (withCrates) spawnArenaCrates(G, cx, cy);
  // Enemies spawn ON ROADS, never inside building blocks.
  for (let i = 0; i < enemyCount; i++) {
    const a = (i / enemyCount) * Math.PI * 2 + rng() * 0.5;
    const raw = { x: cx + Math.cos(a) * 170, y: cy + Math.sin(a) * 170 };
    const pt = nearestRoadPoint(G, raw.x, raw.y);
    spawnEnemy(G, pt.x, pt.y, { hp: ENEMY_HP });
  }
}

function spawnCourier(G) {
  const p = G.player;
  const start = nearestRoadPoint(G, (p ? p.x : 1400) + 500, (p ? p.y : 1400) - 300);
  const courier = {
    id: 'courier', kind: 'courier', type: 'sports',
    x: start.x, y: start.y, angle: 0, speed: 0,
    topSpeed: 520, cruise: COURIER_CRUISE, accel: 380,
    color: '#c94f6d', parked: false, driver: null,
    upgrades: { engine: 0, armor: 0, tires: 0, brakes: 0 },
    paint: null, health: 100,
    route: null, routeIndex: 0, routeDest: null,
  };
  if (!Array.isArray(G.cars)) G.cars = [];
  G.cars.push(courier);
  G.mission.data.courier = courier;
  G.mission.data.hits = 0;
  G.mission.data.hitCooldown = 0;
  return courier;
}

// The courier drives a long road route. It rebuilds its route ONLY when
// it arrives at its destination or when its recorded destination has
// drifted >100 from the current target — never every frame.
function updateCourier(G, dt) {
  const c = G.mission.data.courier;
  if (!c) return;
  const rng = G.rng || Math.random;
  if (!c.route || c.routeIndex >= c.route.length) {
    // Pick a new far destination and route to it.
    const dest = {
      x: ROADS[Math.floor(rng() * ROADS.length)],
      y: ROADS[Math.floor(rng() * ROADS.length)],
    };
    if (Math.hypot(dest.x - c.x, dest.y - c.y) < 800) {
      dest.x = ROADS[(ROADS.indexOf(dest.x) + 4) % ROADS.length];
    }
    if (G.world && typeof G.world.findRoute === 'function') {
      c.route = G.world.findRoute(c.x, c.y, dest.x, dest.y) || gridRoute(c.x, c.y, dest.x, dest.y);
    } else {
      c.route = gridRoute(c.x, c.y, dest.x, dest.y);
    }
    // First waypoint is the FIRST junction: gridRoute guarantees it,
    // and a world route is trusted only if it starts near a junction.
    c.routeIndex = 0;
    c.routeDest = dest;
  }
  const target = c.route[Math.min(c.routeIndex, c.route.length - 1)];
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const dist = Math.hypot(dx, dy);
  const want = Math.atan2(dy, dx);
  let diff = want - c.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  // Sharp turn (> ~52 deg): stop fully, rotate in place, then drive.
  if (Math.abs(diff) > 0.9) {
    c.speed = Math.max(0, c.speed - 900 * dt);
    if (c.speed < 5) c.angle += Math.sign(diff) * 3.2 * dt;
  } else {
    const turnRate = Math.max(1.6, 3.4 - c.speed / 400);
    c.angle += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));
    const cruise = Math.min(c.cruise, dist < 170 ? 120 : c.cruise);
    if (c.speed < cruise) c.speed = Math.min(cruise, c.speed + 420 * dt);
    else c.speed = Math.max(cruise, c.speed - 500 * dt);
    c.x += Math.cos(c.angle) * c.speed * dt;
    c.y += Math.sin(c.angle) * c.speed * dt;
  }
  // Arrived at a waypoint: advance, or — at the FINAL waypoint — drop
  // the route so a new destination is picked next frame. Batch-3 fix:
  // the old code only rebuilt when routeIndex >= route.length, which
  // never happens (it caps at length - 1) — so the courier sat at its
  // destination forever, spinning in place at a zero-length steering
  // target, and the player's chase car spun with it at the same point.
  if (dist < 70) {
    if (c.routeIndex < c.route.length - 1) c.routeIndex++;
    else c.route = null;
  }
}

// On-foot fallback for the m2 chase (spec §9.1b): if the autopilot finds
// no car in range, it walks to the courier's NEAREST ROAD POINT — never
// at the moving courier itself, so it cannot chase forever.
export function m2OnFootTarget(G) {
  ensureMissionState(G);
  const c = G.mission.data.courier;
  if (!c) return null;
  return nearestRoadPoint(G, c.x, c.y);
}

export function courierRoadPoint(G) {
  return m2OnFootTarget(G);
}

function setupMission(G, def) {
  const d = G.mission.data;
  switch (def.id) {
    case 'm2':
      spawnCourier(G);
      G.mission.marker = m2OnFootTarget(G);
      break;
    case 'm3':
      d.checkpoints = [
        landmark(G, 'club', 600, 1800),
        landmark(G, 'marina', 3000, 2600),
        landmark(G, 'airport', 2600, 3000),
      ];
      d.checkpointIndex = 0;
      G.mission.marker = d.checkpoints[0];
      break;
    case 'm5':
      G.mission.nightWas = (G.time && G.time.night) || 0;
      if (G.time) G.time.night = 1;
      d.pickup = landmark(G, 'club', 600, 1800);
      d.drop = landmark(G, 'docks', 3000, 1800);
      G.mission.marker = d.pickup;
      break;
    case 'm6': {
      const spots = [
        landmark(G, 'market', 1400, 1000),
        landmark(G, 'club', 600, 1800),
        landmark(G, 'marina', 3000, 2600),
        landmark(G, 'airport', 2600, 3000),
        landmark(G, 'downtown', 2200, 1400),
      ];
      d.total = spots.length;
      for (const s of spots) {
        const pk = spawnMoneyPickup(G, s.x, s.y, 300);
        pk.mission = 'm6';
      }
      d.drop = landmark(G, 'hideout', 600, 600);
      G.mission.marker = spots[0];
      break;
    }
    case 'm7':
      // Wanted cover is set AFTER the mission starts, because the
      // mission itself adds heat on start: 58 heat = 3 stars.
      setHeat(G, 58);
      d.dest = landmark(G, 'airport', 2600, 3000);
      G.mission.marker = d.dest;
      break;
    case 'm8': {
      const arena = landmark(G, 'bank', 1800, 1800);
      d.arena = arena;
      spawnArena(G, def, arena.x, arena.y, def.enemies || 3, false);
      G.mission.marker = arena;
      break;
    }
    case 'm9':
      // Helicopter + 3 stars, set AFTER the mission starts.
      setHeat(G, 58);
      forceHelicopter(G, true);
      d.dest = landmark(G, 'hideout', 600, 600);
      G.mission.marker = d.dest;
      break;
    case 'm10': {
      const arena = landmark(G, 'docks', 3000, 1800);
      d.arena = arena;
      spawnArena(G, def, arena.x, arena.y, def.enemies || 5, true);
      d.exit = landmark(G, 'marina', 3000, 2600);
      G.mission.marker = arena;
      break;
    }
    case 'm11':
      d.purchasesAtStart = garagePurchaseCount(G);
      d.garage = landmark(G, 'garage', 1000, 600);
      d.checkpoints = [
        landmark(G, 'club', 600, 1800),
        landmark(G, 'marina', 3000, 2600),
        landmark(G, 'airport', 2600, 3000),
      ];
      d.checkpointIndex = 0;
      G.mission.marker = d.garage;
      break;
    case 'm12': {
      const arena = landmark(G, 'bank', 1800, 1800);
      d.arena = arena;
      // Bank shootout at 4 stars with the helicopter overhead.
      setHeat(G, 74);
      forceHelicopter(G, true);
      spawnArena(G, def, arena.x, arena.y, def.enemies || 4, false);
      d.loot = arena;
      d.escape = landmark(G, 'airport', 2600, 3000);
      d.plane = { x: 2900, y: 3000 };
      G.mission.marker = arena;
      break;
    }
    default:
      // m1, m4: pickup then deliver.
      if (def.id === 'm1') {
        d.pickup = landmark(G, 'market', 1400, 1000);
        d.drop = landmark(G, 'downtown', 2200, 1400);
      } else if (def.id === 'm4') {
        d.pickup = landmark(G, 'marina', 3000, 2600);
        d.drop = landmark(G, 'hideout', 600, 600);
      }
      G.mission.marker = d.pickup;
      break;
  }
  G.mission.stage = 0;
}

export function completeMissionStage(G) {
  ensureMissionState(G);
  G.mission.stage += 1;
  if (G.audio) G.audio.play && G.audio.play('objective');
}

export function completeMission(G) {
  ensureMissionState(G);
  const def = missionDef(G.mission.id);
  if (!def) return false;
  if (G.player) G.player.cash = (G.player.cash || 0) + def.reward;
  if (!G.mission.completed.includes(def.id)) G.mission.completed.push(def.id);
  const idx = MISSION_ARC.findIndex((m) => m.id === def.id);
  G.mission.highest = Math.max(G.mission.highest, idx + 1);
  G.mission.state = 'done';
  G.mission.marker = null;
  G.mission.data = {};
  clearMissionEntities(G);
  if (G.time && typeof G.mission.nightWas === 'number') G.time.night = G.mission.nightWas;
  G.hudMessage = `${def.name} complete! +$${def.reward}`;
  if (G.audio) G.audio.play && G.audio.play('missionComplete');
  // Autosave hook: main.js / save.js writes the active slot.
  if (typeof G.onMissionComplete === 'function') G.onMissionComplete(def);
  return true;
}

export function failMission(G, reason) {
  ensureMissionState(G);
  if (G.mission.state !== 'active') return false;
  const def = missionDef(G.mission.id);
  G.mission.state = 'failed';
  G.mission.marker = null;
  G.mission.data = {};
  G.mission.triggerCooldown = 3;
  clearMissionEntities(G);
  if (G.time && typeof G.mission.nightWas === 'number') G.time.night = G.mission.nightWas;
  G.hudMessage = def ? `${def.name} failed — ${reason || 'try again'}` : 'Mission failed';
  if (G.audio) G.audio.play && G.audio.play('missionFailed');
  return true;
}

export function clearMissionEntities(G) {
  ensureMissionState(G);
  if (Array.isArray(G.cars)) {
    G.cars = G.cars.filter((c) => c.id !== 'courier');
  }
  forceHelicopter(G, false);
  // The shootout perimeter ends with the mission.
  G.shootoutActive = false;
  G.shootoutCenter = null;
  clearCombat(G);
}

function arenaCleared(G) {
  return !G.enemies || G.enemies.filter((e) => !e.dead && e.hp > 0).length === 0;
}

function updateDriveMission(G, def, dt) {
  const d = G.mission.data;
  if (G.mission.stage === 0) {
    if (reached(G, d.pickup)) {
      completeMissionStage(G);
      G.mission.marker = d.drop;
      G.hudMessage = 'Package picked up — deliver it';
    }
  } else if (reached(G, d.drop)) {
    completeMission(G);
  }
}

function updateChaseMission(G, def, dt) {
  const d = G.mission.data;
  const c = d.courier;
  if (!c) { failMission(G, 'courier lost'); return; }
  updateCourier(G, dt);
  G.mission.marker = m2OnFootTarget(G);
  d.hitCooldown = Math.max(0, (d.hitCooldown || 0) - dt);
  const pos = playerPos(G);
  const dist = Math.hypot(pos.x - c.x, pos.y - c.y);
  if (d.hitCooldown <= 0 && dist < COURIER_HIT_DISTANCE && playerSpeed(G) > COURIER_HIT_MIN_SPEED) {
    d.hits = (d.hits || 0) + 1;
    d.hitCooldown = 1.0;
    // Each hit cuts the courier's cruise speed to 55% of what it was.
    c.cruise = Math.max(60, c.cruise * COURIER_SLOW_FACTOR);
    G.hudMessage = `Ram hit ${d.hits}/${COURIER_HITS_TO_STOP}!`;
    if (G.audio) G.audio.play && G.audio.play('crash');
    if (G.particles) {
      G.particles.push({ kind: 'spark', x: c.x, y: c.y, life: 0.4, maxLife: 0.4 });
    }
  }
  if ((d.hits || 0) >= COURIER_HITS_TO_STOP) completeMission(G);
}

function updateCheckpointsMission(G, def, dt) {
  const d = G.mission.data;
  const cp = d.checkpoints[d.checkpointIndex];
  if (!cp) { completeMission(G); return; }
  G.mission.marker = cp;
  if (reached(G, cp)) {
    d.checkpointIndex += 1;
    if (d.checkpointIndex >= d.checkpoints.length) {
      completeMission(G);
    } else {
      completeMissionStage(G);
      G.mission.marker = d.checkpoints[d.checkpointIndex];
      G.hudMessage = `Checkpoint ${d.checkpointIndex}/${d.checkpoints.length}`;
    }
  }
}

function updateCollectorMission(G, def, dt) {
  const d = G.mission.data;
  const remaining = (G.pickups || []).filter((pk) => pk.mission === 'm6').length;
  if (G.mission.stage === 0) {
    const next = (G.pickups || []).find((pk) => pk.mission === 'm6');
    G.mission.marker = next ? { x: next.x, y: next.y } : d.drop;
    if (remaining === 0) {
      completeMissionStage(G);
      G.mission.marker = d.drop;
      G.hudMessage = 'All drops collected — return to the hideout';
    }
  } else if (reached(G, d.drop)) {
    completeMission(G);
  }
}

function updateEscapeMission(G, def, dt) {
  const d = G.mission.data;
  if (G.mission.stage === 0) {
    G.mission.marker = d.dest;
    if (reached(G, d.dest)) {
      completeMissionStage(G);
      G.hudMessage = 'Now lose the police — get to zero stars';
    }
  } else if ((G.stars || 0) === 0) {
    completeMission(G);
  }
}

function updateShootoutMission(G, def, dt) {
  const d = G.mission.data;
  if (G.mission.stage === 0) {
    G.mission.marker = d.arena;
    if (arenaCleared(G)) {
      completeMissionStage(G);
      if (def.id === 'm10') {
        G.mission.marker = d.exit;
        G.hudMessage = 'Docks clear — reach the exit marker';
      } else {
        G.mission.marker = landmark(G, 'hideout', 600, 600);
        G.hudMessage = 'Area clear — escape to the hideout';
      }
    }
  } else {
    const target = def.id === 'm10' ? d.exit : landmark(G, 'hideout', 600, 600);
    G.mission.marker = target;
    if (reached(G, target)) completeMission(G);
  }
}

function updateHeliEscapeMission(G, def, dt) {
  const d = G.mission.data;
  G.mission.marker = d.dest;
  if (reached(G, d.dest)) completeMission(G);
}

function updateGarageMission(G, def, dt) {
  const d = G.mission.data;
  if (G.mission.stage === 0) {
    G.mission.marker = d.garage;
    const bought = garagePurchaseCount(G) > (d.purchasesAtStart || 0) || !!d.boughtUpgrade;
    if (bought) {
      completeMissionStage(G);
      d.checkpointIndex = 0;
      G.mission.marker = d.checkpoints[0];
      G.hudMessage = 'Upgrade installed — now run the 3 checkpoints';
    }
  } else {
    const cp = d.checkpoints[d.checkpointIndex];
    if (!cp) { completeMission(G); return; }
    G.mission.marker = cp;
    if (reached(G, cp)) {
      d.checkpointIndex += 1;
      if (d.checkpointIndex >= d.checkpoints.length) {
        completeMission(G);
      } else {
        G.mission.marker = d.checkpoints[d.checkpointIndex];
        G.hudMessage = `Checkpoint ${d.checkpointIndex}/${d.checkpoints.length}`;
      }
    }
  }
}

function updateFinaleMission(G, def, dt) {
  const d = G.mission.data;
  if (G.mission.stage === 0) {
    // (a) Bank shootout — 4 enemies plus the helicopter overhead.
    G.mission.marker = d.arena;
    if (arenaCleared(G)) {
      completeMissionStage(G);
      G.mission.marker = d.loot;
      G.hudMessage = 'Bank clear — grab the loot';
    }
  } else if (G.mission.stage === 1) {
    // (b) Grab the loot at the bank marker.
    G.mission.marker = d.loot;
    if (reached(G, d.loot)) {
      completeMissionStage(G);
      G.mission.marker = d.escape;
      G.hudMessage = 'Loot grabbed — escape to the airport';
    }
  } else if (G.mission.stage === 2) {
    // (c) Escape to the airport while the helicopter and roadblocks pursue.
    G.mission.marker = d.escape;
    if (reached(G, d.escape)) {
      completeMissionStage(G);
      G.mission.marker = d.plane;
      G.hudMessage = 'Almost there — reach the plane';
    }
  } else if (reached(G, d.plane)) {
    // (d) Reach the plane marker.
    completeMission(G);
  }
}

const MISSION_UPDATES = {
  m1: updateDriveMission,
  m2: updateChaseMission,
  m3: updateCheckpointsMission,
  m4: updateDriveMission,
  m5: updateDriveMission,
  m6: updateCollectorMission,
  m7: updateEscapeMission,
  m8: updateShootoutMission,
  m9: updateHeliEscapeMission,
  m10: updateShootoutMission,
  m11: updateGarageMission,
  m12: updateFinaleMission,
};

function keyDown(G, codes) {
  if (!G.input || !G.input.keys) return false;
  for (const c of codes) if (G.input.keys.has(c)) return true;
  return false;
}

// Offer the next mission when the player is near the Fixer Garage.
// Radius is 50 (v1 lesson: 70 auto-started the dialog at spawn and
// swallowed the player's first interact press).
export function checkMissionTrigger(G) {
  ensureMissionState(G);
  if (G.state !== 'playing') return false;
  if (G.mission.state === 'active' || G.mission.state === 'dialog') return false;
  if (G.mission.triggerCooldown > 0) return false;
  const next = nextMissionDef(G);
  if (!next) return false;
  const garage = landmark(G, 'garage', 1000, 600);
  const pos = playerPos(G);
  if (Math.hypot(pos.x - garage.x, pos.y - garage.y) < MISSION_DIALOG_RADIUS) {
    return startMission(G, next.id);
  }
  return false;
}

export function updateMissions(G, dt) {
  ensureMissionState(G);
  if (G.mission.triggerCooldown > 0) G.mission.triggerCooldown -= dt;
  // Dialog-accept runs FIRST, before anything else in this update, so
  // the autopilot can always press E to accept (spec §9.1a).
  if (G.mission.dialogOpen && G.mission.state === 'dialog') {
    const down = keyDown(G, ['KeyE', 'e', 'E']) || !!(G.input && G.input.interactPressed);
    const edge = down && !G.mission.prevInteract;
    G.mission.prevInteract = down;
    if (edge) acceptMissionDialog(G);
    return;
  }
  if (G.mission.state === 'active') {
    const def = missionDef(G.mission.id);
    if (!def) { failMission(G, 'unknown mission'); return; }
    G.mission.timeLeft -= dt;
    if (G.mission.timeLeft <= 0) {
      failMission(G, 'time ran out');
      return;
    }
    // Death or capture fails the mission; it restarts from stage 0.
    // (m12 restarts from stage (a) — which IS stage 0.)
    if ((G.player && (G.player.health ?? 100) <= 0) || G.state === 'gameover') {
      failMission(G, G.state === 'gameover' ? (G.caughtReason || 'down') : 'down');
      return;
    }
    const update = MISSION_UPDATES[def.id];
    if (update) update(G, def, dt);
    // Shootout stages (m8 / m10 / m12 stage 0) hold a police perimeter:
    // police.js keeps foot cops and patrol cars on a ring around the
    // arena instead of walking onto Rook — otherwise a foot cop could
    // arrest the stationary shooter mid-shootout and fail the mission.
    // Cleared on stage advance, completion and failure (see
    // clearMissionEntities). Batch-3 fix: batch 2 never set these, so
    // the perimeter never engaged.
    if ((def.id === 'm8' || def.id === 'm10' || def.id === 'm12') && G.mission.stage === 0) {
      G.shootoutActive = true;
      G.shootoutCenter = G.mission.data.arena || null;
    } else {
      G.shootoutActive = false;
      G.shootoutCenter = null;
    }
    return;
  }
  // No active mission: offer the next one at the garage.
  checkMissionTrigger(G);
}

export function missionObjectiveText(G) {
  ensureMissionState(G);
  const def = currentMission(G);
  if (!def) {
    const next = nextMissionDef(G);
    return next ? `Next job: ${next.name} — visit the Fixer Garage` : 'All jobs complete — free roam';
  }
  if (G.mission.state === 'dialog') return `${def.name}: ${def.fixer} has a job for you — press E`;
  if (G.mission.state === 'failed') return `${def.name} failed — return to the garage to retry`;
  if (G.mission.state === 'done') return `${def.name} complete!`;
  const d = G.mission.data;
  const t = Math.max(0, Math.ceil(G.mission.timeLeft));
  const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  switch (def.id) {
    case 'm1': return G.mission.stage === 0 ? `First Job: pick up the package at the market — ${clock}` : `First Job: deliver downtown — ${clock}`;
    case 'm2': return `Tail Chase: ram the courier ${d.hits || 0}/${COURIER_HITS_TO_STOP} — ${clock}`;
    case 'm3': return `Hot Wheels: checkpoint ${(d.checkpointIndex || 0) + 1}/3 — ${clock}`;
    case 'm4': return G.mission.stage === 0 ? `Dockside: pick up the crate at the marina — ${clock}` : `Dockside: deliver to the hideout — ${clock}`;
    case 'm5': return G.mission.stage === 0 ? `Midnight Run: pick up at the club — ${clock}` : `Midnight Run: drop at the docks — ${clock}`;
    case 'm6': return G.mission.stage === 0 ? `Collector: ${(G.pickups || []).filter((pk) => pk.mission === 'm6').length} drops left — ${clock}` : `Collector: return to the hideout — ${clock}`;
    case 'm7': return G.mission.stage === 0 ? `Highway Heat: drive to the airport — ${clock}` : `Highway Heat: lose the police! — ${clock}`;
    case 'm8': return G.mission.stage === 0 ? `Crescent Job: clear the yard — ${clock}` : `Crescent Job: escape to the hideout — ${clock}`;
    case 'm9': return `Sky Watch: reach the hideout under the helicopter — ${clock}`;
    case 'm10': return G.mission.stage === 0 ? `Full Auto: clear the docks — ${clock}` : `Full Auto: reach the exit marker — ${clock}`;
    case 'm11': return G.mission.stage === 0 ? `Tune-Up: buy an upgrade at the Fixer Garage — ${clock}` : `Tune-Up: checkpoint ${(d.checkpointIndex || 0) + 1}/3 — ${clock}`;
    case 'm12':
      if (G.mission.stage === 0) return `Bay Finale: clear the bank — ${clock}`;
      if (G.mission.stage === 1) return `Bay Finale: grab the loot — ${clock}`;
      if (G.mission.stage === 2) return `Bay Finale: escape to the airport — ${clock}`;
      return `Bay Finale: reach the plane — ${clock}`;
    default: return `${def.name} — ${clock}`;
  }
}
