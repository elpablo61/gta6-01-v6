// pedestrians.js — sidewalk walkers for Crescent Bay. Pedestrians
// walk the sidewalks along the road graph and flee when scared
// (gunshots, a speeding car, a nearby shootout). Variety (spec §3.6
// stretch): different colours and walking speeds, some walking in pairs.

import { WORLD_SIZE } from './config.js';

// Pedestrian shirt / jacket colours: bright enough to read at a glance.
export const PED_COLORS = [
  '#d83a3a', '#3a7bd8', '#3aa655', '#e8a13a', '#c94f9e', '#7a4fd8',
  '#4fd8c9', '#e8e8e8', '#5a6b7a', '#d8d83a', '#8a5a3a', '#2f8f6f',
];

// Make one pedestrian. State: 'walk' | 'flee' | 'idle'.
export function createPedestrian(x, y, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  return {
    x, y,
    angle: typeof o.angle === 'number' ? o.angle : rng() * Math.PI * 2,
    speed: o.speed || (55 + rng() * 55),
    color: o.color || PED_COLORS[Math.floor(rng() * PED_COLORS.length)],
    state: o.state || 'walk',
    target: o.target || null,
    fleeTimer: 0,
    fleeFrom: null,
    pairId: o.pairId || null,
    walkTimer: 0,
  };
}

// Spawn one pedestrian on a sidewalk near a point. Sidewalks run along
// the roads, offset 44 from the centreline (just outside the 64-wide
// road). A pairId links two pedestrians walking together.
export function spawnPedestrian(G, x, y, opts) {
  const o = opts || {};
  if (!Array.isArray(G.peds)) G.peds = [];
  const ped = createPedestrian(x, y, {
    rng: G.rng,
    state: o.flee ? 'flee' : 'walk',
    fleeFrom: o.fleeFrom || null,
    fleeTimer: o.flee ? 2.5 : 0,
    pairId: o.pairId || null,
    speed: o.speed,
    color: o.color,
  });
  if (o.flee && o.fleeFrom) {
    ped.angle = Math.atan2(y - o.fleeFrom.y, x - o.fleeFrom.x);
  }
  G.peds.push(ped);
  return ped;
}

// Pick a new sidewalk waypoint: a point on a nearby road, offset to
// the sidewalk, a few hundred units along the road from the pedestrian.
function pickSidewalkTarget(G, ped) {
  const rng = G.rng || Math.random;
  const roads = (G.world && G.world.roads) || [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
  const horizontal = rng() < 0.5;
  const road = roads[Math.floor(rng() * roads.length)];
  const along = 80 + rng() * (WORLD_SIZE - 160);
  const side = rng() < 0.5 ? -44 : 44;
  // Bias toward the pedestrian's current area so walkers stay local.
  const near = rng() < 0.6;
  if (near && G.world && G.world.nearestRoadPoint) {
    const rp = G.world.nearestRoadPoint(ped.x, ped.y);
    const jitter = (rng() - 0.5) * 700;
    if (Math.abs(rp.x - ped.x) < Math.abs(rp.y - ped.y)) {
      return { x: rp.x + (rng() < 0.5 ? -44 : 44), y: Math.max(60, Math.min(3140, ped.y + jitter)) };
    }
    return { x: Math.max(60, Math.min(3040, ped.x + jitter)), y: rp.y + (rng() < 0.5 ? -44 : 44) };
  }
  return horizontal
    ? { x: along, y: road + side }
    : { x: road + side, y: along };
}

// What scares a pedestrian right now, if anything: a recent gunshot,
// a speeding car close by, or an active shootout nearby.
function scareSource(G, ped) {
  const p = G.player;
  if (G.lastGunshot && (G.time ? G.time.t : 0) - G.lastGunshot.t < 1.5) {
    if (Math.hypot(ped.x - G.lastGunshot.x, ped.y - G.lastGunshot.y) < 260) {
      return { x: G.lastGunshot.x, y: G.lastGunshot.y };
    }
  }
  if (p && p.car && Math.abs(p.car.speed || 0) > 280) {
    if (Math.hypot(ped.x - p.car.x, ped.y - p.car.y) < 130) {
      return { x: p.car.x, y: p.car.y };
    }
  }
  if (G.shootoutActive && G.shootoutCenter) {
    if (Math.hypot(ped.x - G.shootoutCenter.x, ped.y - G.shootoutCenter.y) < 320) {
      return { x: G.shootoutCenter.x, y: G.shootoutCenter.y };
    }
  }
  return null;
}

function movePed(G, ped, tx, ty, speed, dt) {
  const dx = tx - ped.x;
  const dy = ty - ped.y;
  const d = Math.hypot(dx, dy);
  if (d < 4) return true;
  const blocked = (x, y) =>
    (G.world && typeof G.world.isBlockedAt === 'function'
      ? G.world.isBlockedAt(x, y, 8)
      : (x < 8 || x > WORLD_SIZE - 8 || y < 8 || y > WORLD_SIZE - 8));
  const nx = ped.x + (dx / d) * speed * dt;
  const ny = ped.y + (dy / d) * speed * dt;
  // Slide along walls so walkers never stick on a building corner.
  if (!blocked(nx, ny)) { ped.x = nx; ped.y = ny; }
  else if (!blocked(nx, ped.y)) { ped.x = nx; }
  else if (!blocked(ped.x, ny)) { ped.y = ny; }
  else return true; // fully stuck: pick a new target
  ped.angle = Math.atan2(dy, dx);
  return false;
}

function updatePedestrian(G, ped, dt) {
  // Fleeing: run directly away from the scare source.
  if (ped.state === 'flee') {
    ped.fleeTimer -= dt;
    if (ped.fleeTimer <= 0 || !ped.fleeFrom) {
      ped.state = 'walk';
      ped.target = null;
      return;
    }
    const away = Math.atan2(ped.y - ped.fleeFrom.y, ped.x - ped.fleeFrom.x);
    movePed(G, ped, ped.x + Math.cos(away) * 100, ped.y + Math.sin(away) * 100,
      ped.speed * 1.9, dt);
    return;
  }
  const scare = scareSource(G, ped);
  if (scare) {
    ped.state = 'flee';
    ped.fleeFrom = scare;
    ped.fleeTimer = 2 + (G.rng ? G.rng() : Math.random()) * 1.5;
    return;
  }
  if (!ped.target) ped.target = pickSidewalkTarget(G, ped);
  const arrived = movePed(G, ped, ped.target.x, ped.target.y, ped.speed, dt);
  if (arrived || Math.hypot(ped.target.x - ped.x, ped.target.y - ped.y) < 14) {
    // Pause a beat at the corner, then pick a new sidewalk leg.
    ped.walkTimer += dt;
    if (ped.walkTimer > 0.6) {
      ped.walkTimer = 0;
      ped.target = pickSidewalkTarget(G, ped);
    }
  }
}

// Keep pedestrians near the player: spawn up to ~26, despawn far ones.
// Some spawn in pairs (same pairId, nearby targets) for variety.
export function updatePedestrians(G, dt) {
  if (!Array.isArray(G.peds)) G.peds = [];
  const p = G.player;
  const rng = G.rng || Math.random;
  const target = 26;
  if (p) {
    for (let i = G.peds.length - 1; i >= 0; i--) {
      const ped = G.peds[i];
      if (Math.hypot(ped.x - p.x, ped.y - p.y) > 1200) G.peds.splice(i, 1);
    }
  }
  let guard = 0;
  while (G.peds.length < target && guard < 6) {
    guard++;
    const inPair = rng() < 0.3;
    const base = pickSidewalkTarget(G, p || { x: 1600, y: 1600 });
    // Spawn near the player, not anywhere in the city.
    if (p && Math.hypot(base.x - p.x, base.y - p.y) > 900) continue;
    const pairId = inPair ? `pair-${Math.floor(rng() * 1e9)}` : null;
    spawnPedestrian(G, base.x, base.y, { pairId });
    if (inPair) {
      spawnPedestrian(G, base.x + 26, base.y + 10, {
        pairId,
        color: PED_COLORS[Math.floor(rng() * PED_COLORS.length)],
      });
    }
  }
  for (const ped of G.peds) updatePedestrian(G, ped, dt);
}

// Draw pedestrians as small walkers with a white outline so they read
// against the road, plus a tiny shadow offset south-east.
export function drawPedestrians(ctx, G, cam) {
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  for (const ped of G.peds || []) {
    const x = ped.x - px;
    const y = ped.y - py;
    if (x < -40 || x > (ctx.canvas ? ctx.canvas.width + 40 : 2000) ||
        y < -40 || y > (ctx.canvas ? ctx.canvas.height + 40 : 2000)) {
      continue;
    }
    ctx.fillStyle = 'rgba(40, 30, 90, 0.3)';
    ctx.beginPath();
    ctx.ellipse(x + 4, y + 6, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ped.color;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Fleeing walkers get a small panic mark.
    if (ped.state === 'flee') {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', x, y - 16);
    }
  }
}
