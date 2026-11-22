// vehicles.js — car physics for Crescent Bay. Radius-based steering
// so cars can turn inside narrow 64-wide roads, stop-and-rotate for
// sharp turns, wall sliding, stuck recovery, and manual driving.
//
// Steering rules (proved by the v1/v2 rebuilds, built in from the
// start): steering is radius-based; slow down before sharp junction
// turns; when stuck, reverse straight to unwedge; on wall collision
// slide along the wall instead of sticking; guarantee a minimum turn
// authority even at low speed and allow crawl-forward turns; a car
// that must turn sharper than ~52 degrees (|angle diff| > 0.9) STOPS
// fully and rotates in place, then drives straight; brake ahead of
// sharp turns; U-turns crawl at speed 60; wall damage ticks at most
// once per 0.5s.

import { CAR_TYPES, WORLD_SIZE } from './config.js';

// The car colour palette: one car, one identity colour.
export const CAR_COLORS = [
  '#d83a3a', '#e8a13a', '#3a7bd8', '#3aa655', '#e8e8e8', '#2b2b2b',
  '#c94f9e', '#7a4fd8', '#d8d83a', '#4fd8c9', '#b87333', '#8a9ba8',
];

// Make one car object. The shape matches the Builder B contract:
// { id, x, y, angle, speed, topSpeed, accel, type, color, parked,
//   driver, upgrades, paint, health }.
export function createCar(type, x, y, opts) {
  const o = opts || {};
  const def = CAR_TYPES[type] || CAR_TYPES.sedan;
  const car = {
    id: o.id || `car-${Math.floor(Math.random() * 1e9)}`,
    kind: o.kind || 'car',
    type: def.id,
    x, y,
    angle: typeof o.angle === 'number' ? o.angle : 0,
    speed: 0,
    topSpeed: def.topSpeed,
    accel: def.accel,
    handling: def.handling,
    braking: def.braking,
    color: o.color || CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
    parked: !!o.parked,
    driver: o.driver !== undefined ? o.driver : null,
    upgrades: o.upgrades || { engine: 0, armor: 0, tires: 0, brakes: 0 },
    paint: o.paint || null,
    health: typeof o.health === 'number' ? o.health : def.health,
    maxHealth: def.health,
    cruise: typeof o.cruise === 'number' ? o.cruise : 0,
    route: null,
    routeIndex: 0,
    routeDest: null,
    wrecked: false,
    // Internal steering/debug state, written every frame by the driver.
    _wallDmgTimer: 0,
    _stuckTimer: 0,
    _lastX: x,
    _lastY: y,
    _reversing: 0,
    _dbgDiff: 0,
    _dbgWant: 0,
  };
  applyUpgradesToCar(car);
  return car;
}

// Recompute a car's effective top speed from its garage upgrades
// (engine +55 per level). Called by garage.js too, through the same
// per-car upgrades object.
export function applyUpgradesToCar(car) {
  if (!car || !car.upgrades) return car;
  const base = (CAR_TYPES[car.type] || CAR_TYPES.sedan).topSpeed;
  car.topSpeed = base + (car.upgrades.engine || 0) * 55;
  return car;
}

// Damage resistance from armor upgrades: 15% less damage per level.
export function damageMultiplierForCar(car) {
  if (!car || !car.upgrades) return 1;
  return Math.max(0.4, 1 - (car.upgrades.armor || 0) * 0.15);
}

// Effective top speed of a car (base + engine upgrades).
export function effectiveTopSpeed(car) {
  if (!car) return 0;
  const base = (CAR_TYPES[car.type] || CAR_TYPES.sedan).topSpeed;
  return base + ((car.upgrades && car.upgrades.engine) || 0) * 55;
}

// --- shared steering -------------------------------------------------------

// Angle difference wrapped to [-PI, PI].
export function angleDiff(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Steer one car toward a target point for one frame. Returns the
// distance to the target. The caller picks the cruise speed; this
// function only turns, accelerates, brakes, slides and unwedges.
//
// Behaviour: sharp turn (> ~52 deg) stops the car fully and rotates in
// place (a moving turning circle is wider than a 64-wide road); gentle
// turns use a radius-based turn rate that never drops to zero, so
// crawl-forward turns work at low speed; near the target the car
// crawls; a U-turn (|diff| > 2.6) crawls at speed 60.
export function driveCarToward(G, car, tx, ty, dt, cruise) {
  const dx = tx - car.x;
  const dy = ty - car.y;
  const dist = Math.hypot(dx, dy);
  const want = Math.atan2(dy, dx);
  const diff = angleDiff(car.angle, want);
  car._dbgDiff = diff;
  car._dbgWant = want;
  const handling = (car.handling || 1) * (1 + ((car.upgrades && car.upgrades.tires) || 0) * 0.12);
  const braking = (car.braking || 1) * (1 + ((car.upgrades && car.upgrades.brakes) || 0) * 0.15);

  // Stuck detection: barely moved while trying to drive.
  const moved = Math.hypot(car.x - car._lastX, car.y - car._lastY);
  if (moved < 3 && Math.abs(car.speed) > 40 && car._reversing <= 0) {
    car._stuckTimer += dt;
  } else {
    car._stuckTimer = 0;
  }
  car._lastX = car.x;
  car._lastY = car.y;
  // Reverse straight to unwedge, then resume normal driving. The
  // reverse step respects walls too — never push through a building.
  if (car._stuckTimer > 1.5 || car._reversing > 0) {
    if (car._reversing <= 0) car._reversing = 0.9;
    car._reversing -= dt;
    car.speed = -70;
    const bx = car.x - Math.cos(car.angle) * 70 * dt;
    const by = car.y - Math.sin(car.angle) * 70 * dt;
    const blocked = (x, y) =>
      (G.world && typeof G.world.isBlockedAt === 'function'
        ? G.world.isBlockedAt(x, y, 12)
        : (x < 12 || x > WORLD_SIZE - 12 || y < 12 || y > WORLD_SIZE - 12));
    if (!blocked(bx, by)) {
      car.x = bx;
      car.y = by;
    }
    if (car._reversing <= 0) car._stuckTimer = 0;
    return dist;
  }

  // Sharp turn: STOP fully, rotate in place, then drive straight.
  if (Math.abs(diff) > 0.9) {
    car.speed = Math.max(0, car.speed - 900 * dt);
    if (car.speed < 5) {
      car.angle += Math.sign(diff) * 3.2 * handling * dt;
    }
    return dist;
  }

  // Radius-based turn rate: tighter at low speed, never zero authority.
  const turnRate = Math.max(1.6, 3.4 - Math.abs(car.speed) / 400) * handling;
  car.angle += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));

  // Cruise speed: crawl near the waypoint, crawl through U-turns,
  // brake ahead of the next sharp turn (the caller passes the cruise).
  let target = cruise;
  if (dist < 170) target = Math.min(target, 120);
  if (Math.abs(diff) > 2.6) target = Math.min(target, 60);
  if (car.speed < target) {
    car.speed = Math.min(target, car.speed + (car.accel || 300) * dt);
  } else {
    car.speed = Math.max(target, car.speed - 500 * braking * dt);
  }

  moveCarWithWalls(G, car, dt);
  return dist;
}

// Move a car forward along its heading, sliding along walls instead of
// sticking, with wall damage ticking at most once per 0.5s.
export function moveCarWithWalls(G, car, dt) {
  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  const blocked = (x, y) =>
    (G.world && typeof G.world.isBlockedAt === 'function'
      ? G.world.isBlockedAt(x, y, 12)
      : (x < 12 || x > WORLD_SIZE - 12 || y < 12 || y > WORLD_SIZE - 12));
  car._wallDmgTimer = Math.max(0, (car._wallDmgTimer || 0) - dt);
  if (!blocked(nx, ny)) {
    car.x = nx;
    car.y = ny;
    return;
  }
  // Wall: slide along it (X-only, then Y-only) instead of sticking.
  let slid = false;
  if (!blocked(nx, car.y)) { car.x = nx; slid = true; }
  else if (!blocked(car.x, ny)) { car.y = ny; slid = true; }
  car.speed *= 0.6;
  if (car._wallDmgTimer <= 0) {
    car._wallDmgTimer = 0.5;
    damageCar(G, car, 3);
    if (G.audio) G.audio.play && G.audio.play('crash');
  }
  if (!slid) car.speed *= 0.5;
}

// Damage a car (armor upgrades reduce it). A wrecked car stops dead.
export function damageCar(G, car, amount) {
  if (!car || car.wrecked) return;
  const factor = damageMultiplierForCar(car);
  car.health = Math.max(0, (car.health ?? 100) - amount * factor);
  if (car.health <= 0) {
    car.wrecked = true;
    car.speed = 0;
    if (G.particles) {
      for (let i = 0; i < 10; i++) {
        G.particles.push({
          kind: 'smoke', x: car.x, y: car.y,
          life: 1.2, maxLife: 1.2,
          vx: (Math.random() - 0.5) * 60, vy: -30 - Math.random() * 40,
        });
      }
    }
  }
}

// Drive a car along its route (array of waypoints, first waypoint is
// the FIRST junction — never a diagonal cut across a block). Returns
// 'driving' or 'arrived'. Rebuilds nothing: the caller owns the route.
export function driveRoute(G, car, dt, cruise) {
  if (!car.route || car.routeIndex >= car.route.length) return 'arrived';
  const target = car.route[Math.min(car.routeIndex, car.route.length - 1)];
  const dist = driveCarToward(G, car, target.x, target.y, dt, cruise);
  // Wide acceptance (70): a turning circle wider than the road would
  // orbit a tight waypoint forever.
  if (dist < 70 && car.routeIndex < car.route.length - 1) car.routeIndex++;
  else if (dist < 46 && car.routeIndex >= car.route.length - 1) return 'arrived';
  return 'driving';
}

// Build (or rebuild) a route for a car to a destination. The route's
// recorded destination is stored so callers can rebuild only when the
// target moved >100 from it (never every frame).
export function routeCarTo(G, car, tx, ty) {
  let route = null;
  if (G.world && typeof G.world.findRoute === 'function') {
    route = G.world.findRoute(car.x, car.y, tx, ty);
  }
  if (!route) {
    // Fallback: nearest junction, then the exact target.
    const j = G.world && G.world.nearestJunction
      ? G.world.nearestJunction(car.x, car.y)
      : { x: 200, y: 200 };
    route = [j, { x: tx, y: ty }];
  }
  car.route = route;
  car.routeIndex = 0;
  car.routeDest = { x: tx, y: ty };
  return route;
}

// --- parked cars -----------------------------------------------------------

// Spawn parked cars along roadsides around the city. Parked cars sit
// just off the centreline (sidewalk edge) facing along the road.
export function spawnParkedCars(G, count) {
  const rng = G.rng || Math.random;
  const types = ['sedan', 'sedan', 'taxi', 'truck', 'sports', 'sedan'];
  const want = typeof count === 'number' ? count : 26;
  let placed = 0;
  let guard = 0;
  while (placed < want && guard < want * 12) {
    guard++;
    const horizontal = rng() < 0.5;
    const road = (G.world ? G.world.roads : [200, 600, 1000, 1400, 1800, 2200, 2600, 3000])
      [Math.floor(rng() * 8)];
    const along = 120 + rng() * (WORLD_SIZE - 240);
    const side = rng() < 0.5 ? -44 : 44;
    const x = horizontal ? along : road + side;
    const y = horizontal ? road + side : along;
    if (x < 60 || x > 3040 || y < 60 || y > 3140) continue;
    if (G.world && G.world.isBlockedAt(x, y, 16)) continue;
    // Keep parked cars clear of the garage / mission trigger area and
    // of each other.
    if (Math.hypot(x - 600, y - 1000) < 120) continue;
    let tooClose = false;
    for (const c of G.cars) {
      if (Math.hypot(c.x - x, c.y - y) < 70) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const type = types[Math.floor(rng() * types.length)];
    const angle = horizontal ? (side > 0 ? 0 : Math.PI) : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
    const car = createCar(type, x, y, {
      id: `parked-${placed}`,
      angle,
      parked: true,
      driver: null,
    });
    G.cars.push(car);
    placed++;
  }
  return placed;
}

// --- manual driving (the player's car) -------------------------------------

// Drive the player's car from the live input. Returns true when this
// frame was driven by the player (manual input). The autopilot sets
// G.autopilotDrove instead, and main.js skips this call on those
// frames — otherwise the manual branch brakes the car back to ~0
// every frame and it can never build speed.
export function updatePlayerCar(G, dt) {
  const p = G.player;
  if (!p || !p.car) return false;
  const car = p.car;
  if (car.wrecked) {
    car.speed = 0;
    p.speed = 0;
    return false;
  }
  const input = G.autopilotActive && G.autoInput ? G.autoInput : G.input;
  const keys = input ? input.keys : null;
  const has = (codes) => {
    if (!keys) return false;
    for (const c of codes) if (keys.has(c)) return true;
    return false;
  };
  const throttle = has(['KeyW', 'ArrowUp']);
  const brake = has(['KeyS', 'ArrowDown']);
  const steerLeft = has(['KeyA', 'ArrowLeft']);
  const steerRight = has(['KeyD', 'ArrowRight']);
  const handbrake = has(['Space']);

  // Steering: radius-based with a guaranteed minimum authority even at
  // low speed, and crawl-forward turns (creep while turning at a crawl).
  const steer = (steerRight ? 1 : 0) - (steerLeft ? 1 : 0);
  const speedAbs = Math.abs(car.speed);
  if (steer !== 0 && (speedAbs > 4 || throttle)) {
    const turnRate = Math.max(1.5, 2.9 - speedAbs / 420)
      * (car.handling || 1)
      * (1 + ((car.upgrades && car.upgrades.tires) || 0) * 0.12);
    const dir = car.speed < 0 ? -1 : 1;
    car.angle += steer * turnRate * dt * dir;
    // Crawl-forward turn: creeping forward while turning at a crawl.
    if (speedAbs < 30 && throttle) car.speed = Math.max(car.speed, 40);
  }

  if (throttle) {
    car.speed = Math.min(car.topSpeed, car.speed + car.accel * dt);
  } else if (brake) {
    if (car.speed > 20) {
      car.speed = Math.max(0, car.speed - 520 * (car.braking || 1) * dt);
    } else {
      // Reverse, capped well below forward speed.
      car.speed = Math.max(-160, car.speed - 260 * dt);
    }
  } else {
    // Coast down with light drag.
    if (car.speed > 0) car.speed = Math.max(0, car.speed - 140 * dt);
    else if (car.speed < 0) car.speed = Math.min(0, car.speed + 200 * dt);
  }
  if (handbrake) {
    car.speed *= Math.max(0, 1 - 3.2 * dt);
    if (speedAbs > 120 && G.particles) {
      G.particles.push({
        kind: 'skid', x: car.x, y: car.y, life: 1.6, maxLife: 1.6,
        vx: 0, vy: 0, angle: car.angle,
      });
    }
  }

  moveCarWithWalls(G, car, dt);

  // Smoke when badly damaged.
  if (car.health < 35 && G.particles && Math.random() < 0.3) {
    G.particles.push({
      kind: 'smoke', x: car.x, y: car.y, life: 0.9, maxLife: 0.9,
      vx: 0, vy: -25,
    });
  }

  // The player rides the car: position, facing and speed follow it.
  p.x = car.x;
  p.y = car.y;
  p.angle = car.angle;
  p.speed = Math.abs(car.speed);
  return true;
}
