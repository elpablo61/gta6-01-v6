// police.js — wanted heat, foot cops, patrol cars, roadblocks, dispatch.
// Crescent Bay. Wanted heat 0-100; stars at fixed thresholds. Police never
// read a stars value off any cop array: stars always come from G.stars or
// from starsFromHeat(G.heat). Foot-cop movement runs from updatePolice,
// the single dispatcher in this file.
export const WANTED_STAR_THRESHOLDS = [0, 12, 30, 52, 74, 92];

export const POLICE_CONFIG = {
  heatDecayPerSecond: 4,
  hideDistance: 450,
  hideTimeSeconds: 3,
  arrestDistance: 30,
  arrestHoldSeconds: 1.2,
  arrestMaxPlayerSpeed: 60,
  footCopSpeed: 150,
  footCopSprintSpeed: 210,
  patrolCruise: 470,
  patrolTopSpeed: 560,
  roadblockMinStars: 4,
  sprayShopRadius: 150,
  sprayShopDrainPerSecond: 50,
  patrolSprayAvoid: 130,
  perimeterRadius: 420,
  perimeterMinDistance: 300,
};

export function starsFromHeat(heat) {
  let stars = 0;
  for (let i = 0; i < WANTED_STAR_THRESHOLDS.length; i++) {
    if (heat >= WANTED_STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

export function ensurePoliceState(G) {
  if (!G.police) {
    G.police = { footCops: [], patrolCars: [], roadblocks: [], hideTimer: 0, arrestTimer: 0 };
  }
  if (!Array.isArray(G.police.footCops)) G.police.footCops = [];
  if (!Array.isArray(G.police.patrolCars)) G.police.patrolCars = [];
  if (!Array.isArray(G.police.roadblocks)) G.police.roadblocks = [];
  if (typeof G.heat !== 'number') G.heat = 0;
  if (typeof G.stars !== 'number') G.stars = 0;
  return G.police;
}

export function addHeat(G, amount) {
  ensurePoliceState(G);
  G.heat = Math.max(0, Math.min(100, G.heat + amount));
  G.stars = starsFromHeat(G.heat);
}

export function setHeat(G, value) {
  ensurePoliceState(G);
  G.heat = Math.max(0, Math.min(100, value));
  G.stars = starsFromHeat(G.heat);
}

// Heat decays only while hidden: no police within 450 for 3s in a row.
// The helicopter spotlight BLOCKS decay while it is on Rook — keyed on
// G.helicopter.spotlightOnPlayer, never on the helicopter merely existing.
export function updateWantedHeat(G, dt) {
  ensurePoliceState(G);
  const stars = starsFromHeat(G.heat);
  G.stars = stars;
  // No early return on stars === 0: the Spray Shop drain below must be
  // able to finish the job (heat 12 -> 0), and hiding decay must also
  // run heat down to zero. Returning early here used to freeze heat at
  // ~12 forever once stars hit 0 — the shop could never fully clear a
  // wanted level.
  const p = G.player;
  // Spray Shop repaint clears heat fast while the player is inside it.
  // A repaint is NOT hiding, so the helicopter spotlight does NOT block
  // it: the drain runs first, before the spotlight early-return below.
  // (Before this fix the spotlight return sat above the drain, so at
  // 5 stars — exactly when the helicopter is always overhead — the
  // Spray Shop could never clear heat at all.)
  const shop = G.world && G.world.sprayShop;
  if (shop && Math.hypot(p.x - shop.x, p.y - shop.y) < POLICE_CONFIG.sprayShopRadius) {
    G.heat = Math.max(0, G.heat - POLICE_CONFIG.sprayShopDrainPerSecond * dt);
    G.stars = starsFromHeat(G.heat);
  }
  if (G.helicopter && G.helicopter.spotlightOnPlayer) {
    G.police.hideTimer = 0;
    return;
  }
  let nearest = Infinity;
  for (const cop of G.police.footCops) {
    nearest = Math.min(nearest, Math.hypot(cop.x - p.x, cop.y - p.y));
  }
  for (const car of G.police.patrolCars) {
    nearest = Math.min(nearest, Math.hypot(car.x - p.x, car.y - p.y));
  }
  if (nearest > POLICE_CONFIG.hideDistance) {
    G.police.hideTimer += dt;
    if (G.police.hideTimer >= POLICE_CONFIG.hideTimeSeconds) {
      G.heat = Math.max(0, G.heat - POLICE_CONFIG.heatDecayPerSecond * dt);
      G.stars = starsFromHeat(G.heat);
    }
  } else {
    G.police.hideTimer = 0;
  }
}

function roadPointNear(G, x, y) {
  if (G.world && typeof G.world.nearestRoadPoint === 'function') {
    return G.world.nearestRoadPoint(x, y);
  }
  const roads = (G.world && G.world.roads) || [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
  let bx = roads[0];
  let by = roads[0];
  for (const r of roads) {
    if (Math.abs(r - x) < Math.abs(bx - x)) bx = r;
    if (Math.abs(r - y) < Math.abs(by - y)) by = r;
  }
  return Math.abs(bx - x) < Math.abs(by - y) ? { x: bx, y } : { x, y: by };
}

function blockedAt(G, x, y) {
  if (G.world && typeof G.world.isBlockedAt === 'function') return G.world.isBlockedAt(x, y);
  return false;
}

function moveOnFoot(G, e, tx, ty, speed, dt) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 4) return;
  const nx = e.x + (dx / d) * speed * dt;
  const ny = e.y + (dy / d) * speed * dt;
  // Slide along walls: try full step, then X-only, then Y-only.
  if (!blockedAt(G, nx, ny)) { e.x = nx; e.y = ny; }
  else if (!blockedAt(G, nx, e.y)) { e.x = nx; }
  else if (!blockedAt(G, e.x, ny)) { e.y = ny; }
  e.angle = Math.atan2(dy, dx);
}

// Spawn points ahead of the player, on the road graph, so pursuit
// arrives from the front instead of popping in behind.
export function dispatchPolice(G, count) {
  const p = G.player;
  const spots = [];
  const rng = G.rng || Math.random;
  for (let i = 0; i < count; i++) {
    const ahead = 500 + rng() * 500;
    const side = (rng() - 0.5) * 700;
    const ang = (p.angle || 0) + (rng() - 0.5) * 1.2;
    const raw = { x: p.x + Math.cos(ang) * ahead + Math.cos(ang + Math.PI / 2) * side,
                  y: p.y + Math.sin(ang) * ahead + Math.sin(ang + Math.PI / 2) * side };
    const pt = roadPointNear(G, raw.x, raw.y);
    pt.x = Math.max(40, Math.min(3160, pt.x));
    pt.y = Math.max(40, Math.min(3160, pt.y));
    spots.push(pt);
  }
  return spots;
}

function spawnFootCop(G, x, y) {
  return { kind: 'foot', x, y, angle: 0, speed: 0, route: null, routeTimer: 0,
           repathTimer: 0, stuckTimer: 0, lastX: x, lastY: y };
}

function spawnPatrolCar(G, x, y) {
  return { kind: 'patrol', x, y, angle: 0, speed: 0, topSpeed: POLICE_CONFIG.patrolTopSpeed,
           cruise: POLICE_CONFIG.patrolCruise, route: null, routeIndex: 0,
           repathTimer: 0, stuckTimer: 0, lastX: x, lastY: y, lightPhase: 0 };
}

function desiredCounts(stars) {
  if (stars <= 0) return { foot: 0, patrol: 0, roadblocks: 0 };
  return {
    foot: stars >= 1 ? Math.min(2 + stars, 6) : 0,
    patrol: stars >= 2 ? Math.min(stars, 4) : 0,
    roadblocks: stars >= POLICE_CONFIG.roadblockMinStars ? 2 : 0,
  };
}

function updateFootCop(G, cop, dt) {
  const p = G.player;
  // During a shootout the police hold a ring around the arena: never
  // pile onto one spot.
  if (G.shootoutActive && G.shootoutCenter) {
    const cx = G.shootoutCenter.x;
    const cy = G.shootoutCenter.y;
    const d = Math.hypot(cop.x - cx, cop.y - cy);
    const ringA = Math.atan2(cop.y - cy, cop.x - cx);
    const tx = cx + Math.cos(ringA) * POLICE_CONFIG.perimeterRadius;
    const ty = cy + Math.sin(ringA) * POLICE_CONFIG.perimeterRadius;
    if (d < POLICE_CONFIG.perimeterMinDistance) {
      moveOnFoot(G, cop, tx, ty, POLICE_CONFIG.footCopSpeed, dt);
      return;
    }
    // On the ring: hold position, face the arena.
    cop.angle = Math.atan2(cy - cop.y, cx - cop.x);
    return;
  }
  const dist = Math.hypot(p.x - cop.x, p.y - cop.y);
  const speed = dist > 500 ? POLICE_CONFIG.footCopSprintSpeed : POLICE_CONFIG.footCopSpeed;
  // Chase on foot via the nearest road point, then the last leg direct.
  cop.repathTimer -= dt;
  if (cop.repathTimer <= 0 || !cop.route) {
    cop.repathTimer = 1.5;
    const rp = roadPointNear(G, p.x, p.y);
    cop.route = [rp, { x: p.x, y: p.y }];
    cop.routeIndex = 0;
  }
  const target = cop.route[Math.min(cop.routeIndex || 0, cop.route.length - 1)];
  moveOnFoot(G, cop, target.x, target.y, speed, dt);
  if (Math.hypot(target.x - cop.x, target.y - cop.y) < 24 && cop.routeIndex < cop.route.length - 1) {
    cop.routeIndex++;
  }
  // Stuck detection: if barely moved in 2s, repath immediately.
  if (Math.hypot(cop.x - cop.lastX, cop.y - cop.lastY) < 4) {
    cop.stuckTimer += dt;
    if (cop.stuckTimer > 2) { cop.route = null; cop.stuckTimer = 0; }
  } else {
    cop.stuckTimer = 0;
  }
  cop.lastX = cop.x;
  cop.lastY = cop.y;
}

function steerCarToward(G, car, tx, ty, dt) {
  const dx = tx - car.x;
  const dy = ty - car.y;
  const dist = Math.hypot(dx, dy);
  const want = Math.atan2(dy, dx);
  let diff = want - car.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  // Sharp turn (> ~52 deg): STOP fully, rotate in place, then drive
  // straight. A moving turning circle is wider than a 64-wide road.
  if (Math.abs(diff) > 0.9) {
    car.speed = Math.max(0, car.speed - 900 * dt);
    if (car.speed < 5) {
      car.angle += Math.sign(diff) * 3.2 * dt;
    }
    return dist;
  }
  const turnRate = Math.max(1.6, 3.4 - car.speed / 400);
  car.angle += Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));
  const cruise = car.cruise || 400;
  const target = Math.min(cruise, dist < 170 ? 120 : cruise);
  if (car.speed < target) car.speed = Math.min(target, car.speed + 420 * dt);
  else car.speed = Math.max(target, car.speed - 500 * dt);
  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  if (!blockedAt(G, nx, ny)) { car.x = nx; car.y = ny; }
  else {
    // Wall: slide along it instead of sticking.
    if (!blockedAt(G, nx, car.y)) car.x = nx;
    else if (!blockedAt(G, car.x, ny)) car.y = ny;
    car.speed *= 0.6;
  }
  return dist;
}

function updatePatrolCar(G, car, dt) {
  const p = G.player;
  car.lightPhase += dt;
  // Patrol cars brake and reverse away within 130 of the Spray Shop.
  const shop = G.world && G.world.sprayShop;
  if (shop && Math.hypot(car.x - shop.x, car.y - shop.y) < POLICE_CONFIG.patrolSprayAvoid) {
    car.speed = Math.max(-120, car.speed - 500 * dt);
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    return;
  }
  if (G.shootoutActive && G.shootoutCenter) {
    const cx = G.shootoutCenter.x;
    const cy = G.shootoutCenter.y;
    const ringA = Math.atan2(car.y - cy, car.x - cx);
    const tx = cx + Math.cos(ringA) * POLICE_CONFIG.perimeterRadius;
    const ty = cy + Math.sin(ringA) * POLICE_CONFIG.perimeterRadius;
    const d = Math.hypot(car.x - cx, car.y - cy);
    if (d < POLICE_CONFIG.perimeterMinDistance) {
      steerCarToward(G, car, tx, ty, dt);
      return;
    }
    car.speed = Math.max(0, car.speed - 400 * dt);
    return;
  }
  car.repathTimer -= dt;
  if (car.repathTimer <= 0 || !car.route) {
    car.repathTimer = 1.2;
    if (G.world && typeof G.world.findRoute === 'function') {
      car.route = G.world.findRoute(car.x, car.y, p.x, p.y) || [{ x: p.x, y: p.y }];
    } else {
      car.route = [roadPointNear(G, p.x, p.y), { x: p.x, y: p.y }];
    }
    car.routeIndex = 0;
  }
  const target = car.route[Math.min(car.routeIndex || 0, car.route.length - 1)];
  const dist = steerCarToward(G, car, target.x, target.y, dt);
  if (dist < 70 && car.routeIndex < car.route.length - 1) car.routeIndex++;
  // Stuck: reverse straight to unwedge.
  if (Math.hypot(car.x - car.lastX, car.y - car.lastY) < 3 && car.speed > 40) {
    car.stuckTimer += dt;
    if (car.stuckTimer > 1.5) {
      car.x -= Math.cos(car.angle) * 60 * dt;
      car.y -= Math.sin(car.angle) * 60 * dt;
      if (car.stuckTimer > 2.5) { car.route = null; car.stuckTimer = 0; }
    }
  } else {
    car.stuckTimer = 0;
  }
  car.lastX = car.x;
  car.lastY = car.y;
  // Ramming the player's car: light contact damage, capped rate.
  if (p.car) {
    const d = Math.hypot(car.x - p.car.x, car.y - p.car.y);
    if (d < 46) {
      car.ramTimer = (car.ramTimer || 0) - dt;
      if (car.ramTimer <= 0) {
        car.ramTimer = 0.5;
        p.car.health = Math.max(0, (p.car.health ?? 100) - 3);
        if (G.audio) G.audio.play && G.audio.play('crash');
      }
    }
  }
}

function updateRoadblocks(G, dt) {
  const p = G.player;
  for (const rb of G.police.roadblocks) {
    rb.lightPhase = (rb.lightPhase || 0) + dt;
    // Roadblock cars sit across the road ahead of the player; refresh
    // position if the player has driven far past them.
    if (Math.hypot(rb.x - p.x, rb.y - p.y) > 900) {
      const pt = roadPointNear(G, p.x + Math.cos(p.angle || 0) * 500,
        p.y + Math.sin(p.angle || 0) * 500);
      rb.x = pt.x;
      rb.y = pt.y;
    }
  }
}

// Arrest rule: a foot cop must stay within 30 units of a SLOW on-foot
// player for 1.2s in a row. Running away breaks it.
function updateArrest(G, dt) {
  const p = G.player;
  if (!p.onFoot || G.stars === 0) {
    G.police.arrestTimer = 0;
    return;
  }
  let touching = false;
  for (const cop of G.police.footCops) {
    if (Math.hypot(cop.x - p.x, cop.y - p.y) < POLICE_CONFIG.arrestDistance) {
      touching = true;
      break;
    }
  }
  const playerSpeed = Math.abs(p.speed || 0);
  if (touching && playerSpeed < POLICE_CONFIG.arrestMaxPlayerSpeed) {
    G.police.arrestTimer += dt;
    if (G.police.arrestTimer >= POLICE_CONFIG.arrestHoldSeconds) {
      G.police.arrestTimer = 0;
      if (typeof G.onCaught === 'function') G.onCaught();
      else G.state = 'gameover';
      G.caughtReason = 'CAUGHT';
    }
  } else {
    G.police.arrestTimer = 0;
  }
}

export function updatePolice(G, dt) {
  ensurePoliceState(G);
  const stars = starsFromHeat(G.heat);
  G.stars = stars;
  const want = desiredCounts(stars);
  const p = G.player;
  if (!p) return;
  // Spawn to desired counts, from dispatch points ahead of the player.
  while (G.police.footCops.length < want.foot) {
    const spot = dispatchPolice(G, 1)[0];
    G.police.footCops.push(spawnFootCop(G, spot.x, spot.y));
  }
  while (G.police.patrolCars.length < want.patrol) {
    const spot = dispatchPolice(G, 1)[0];
    G.police.patrolCars.push(spawnPatrolCar(G, spot.x, spot.y));
  }
  while (G.police.roadblocks.length < want.roadblocks) {
    const spot = dispatchPolice(G, 1)[0];
    G.police.roadblocks.push({ kind: 'roadblock', x: spot.x, y: spot.y,
      angle: 0, lightPhase: 0 });
  }
  // Despawn extras when wanted falls.
  G.police.footCops.length = Math.min(G.police.footCops.length, want.foot);
  G.police.patrolCars.length = Math.min(G.police.patrolCars.length, want.patrol);
  G.police.roadblocks.length = Math.min(G.police.roadblocks.length, want.roadblocks);
  // Each cop moves from THIS dispatcher — never from a helper that reads
  // a property off the cop array itself.
  for (const cop of G.police.footCops) updateFootCop(G, cop, dt);
  for (const car of G.police.patrolCars) updatePatrolCar(G, car, dt);
  updateRoadblocks(G, dt);
  updateArrest(G, dt);
}

export function clearAllPolice(G) {
  ensurePoliceState(G);
  G.police.footCops = [];
  G.police.patrolCars = [];
  G.police.roadblocks = [];
  G.police.hideTimer = 0;
  G.police.arrestTimer = 0;
  G.heat = 0;
  G.stars = 0;
}

export function drawPolice(ctx, G, cam) {
  ensurePoliceState(G);
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  for (const cop of G.police.footCops) {
    const x = cop.x - px;
    const y = cop.y - py;
    ctx.fillStyle = '#1c2f6e';
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#8fb7ff';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const car of G.police.patrolCars) {
    const x = car.x - px;
    const y = car.y - py;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(car.angle);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(-20, -10, 40, 20);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(-20, -10, 40, 7);
    const blink = Math.floor(car.lightPhase * 6) % 2 === 0;
    ctx.fillStyle = blink ? '#ff2a2a' : '#2a6bff';
    ctx.fillRect(-8, -12, 8, 5);
    ctx.fillStyle = blink ? '#2a6bff' : '#ff2a2a';
    ctx.fillRect(0, -12, 8, 5);
    ctx.restore();
  }
  for (const rb of G.police.roadblocks) {
    const x = rb.x - px;
    const y = rb.y - py;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rb.angle || 0);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(-20, -10, 40, 20);
    const blink = Math.floor((rb.lightPhase || 0) * 6) % 2 === 0;
    ctx.fillStyle = blink ? '#ff2a2a' : '#2a6bff';
    ctx.fillRect(-8, -12, 16, 5);
    ctx.fillStyle = '#e8a13a';
    ctx.fillRect(-24, -3, 6, 6);
    ctx.fillRect(18, -3, 6, 6);
    ctx.restore();
  }
}
