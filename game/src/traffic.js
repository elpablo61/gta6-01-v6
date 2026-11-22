// traffic.js — city traffic for Crescent Bay. Traffic cars follow
// the road graph, slow behind the car ahead, and spawn / despawn
// around the player so only nearby cars are simulated.
//
// Density varies by time of day (spec §3.6 stretch): busier at midday,
// quieter at night. The player's own car is never traffic: it is
// excluded from every traffic update.

import { createCar, driveRoute, routeCarTo, effectiveTopSpeed } from './vehicles.js';

// How many traffic cars to keep, by time of day.
export function trafficTargetCount(G) {
  const hour = (G.time && typeof G.time.hour === 'number') ? G.time.hour : 12;
  if (hour >= 22 || hour < 6) return 8; // quiet night
  if (hour >= 10 && hour <= 16) return 16; // busy midday
  return 12;
}

export function ensureTrafficState(G) {
  if (!Array.isArray(G.cars)) G.cars = [];
  if (!Array.isArray(G.traffic)) G.traffic = [];
  return G.traffic;
}

// Spawn one traffic car at a junction near the player, already routed
// to a far random junction.
export function spawnTrafficCar(G) {
  ensureTrafficState(G);
  const rng = G.rng || Math.random;
  const types = ['sedan', 'sedan', 'taxi', 'truck', 'sedan', 'sports'];
  const type = types[Math.floor(rng() * types.length)];
  // Spawn on the road graph ahead of the player, never on top of them.
  const p = G.player || { x: 1600, y: 1600 };
  let x = 600;
  let y = 600;
  for (let tries = 0; tries < 12; tries++) {
    const j = G.world && G.world.randomJunction
      ? G.world.randomJunction()
      : { x: 200 + Math.floor(rng() * 8) * 400, y: 200 + Math.floor(rng() * 8) * 400 };
    const d = Math.hypot(j.x - p.x, j.y - p.y);
    if (d > 350 && d < 1000) { x = j.x; y = j.y; break; }
    x = j.x;
    y = j.y;
  }
  const car = createCar(type, x, y, {
    id: `traffic-${Math.floor(rng() * 1e9)}`,
    angle: Math.floor(rng() * 4) * (Math.PI / 2),
    parked: false,
    driver: 'traffic',
    cruise: 240 + rng() * 90,
  });
  G.cars.push(car);
  G.traffic.push(car);
  pickNewDestination(G, car);
  return car;
}

// Pick a far random junction as the car's next destination and route
// to it. The route starts at the FIRST junction (never a diagonal cut
// across a block) because routeCarTo uses the world BFS finder.
function pickNewDestination(G, car) {
  const rng = G.rng || Math.random;
  const roads = (G.world && G.world.roads) || [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
  const dest = {
    x: roads[Math.floor(rng() * roads.length)],
    y: roads[Math.floor(rng() * roads.length)],
  };
  if (Math.hypot(dest.x - car.x, dest.y - car.y) < 700) {
    dest.x = roads[(roads.indexOf(dest.x) + 4) % roads.length];
  }
  routeCarTo(G, car, dest.x, dest.y);
}

// The car ahead of this one, if any: nearest car within 90 units in
// the forward cone. Traffic slows behind it instead of rear-ending it.
function carAhead(G, car) {
  let best = null;
  let bestD = 95;
  for (const other of G.cars) {
    if (other === car || other.parked) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const d = Math.hypot(dx, dy);
    if (d >= bestD || d < 1) continue;
    // Ahead means roughly in front of the heading.
    const dot = (dx * Math.cos(car.angle) + dy * Math.sin(car.angle)) / d;
    if (dot > 0.55) {
      best = other;
      bestD = d;
    }
  }
  return best ? { car: best, dist: bestD } : null;
}

// One traffic car for one frame: follow its route, slow behind the car
// ahead, pick a new destination on arrival.
function updateTrafficCar(G, car, dt) {
  if (car.wrecked) return;
  if (!car.route || car.routeIndex >= car.route.length) {
    pickNewDestination(G, car);
    return;
  }
  let cruise = car.cruise || 280;
  const ahead = carAhead(G, car);
  if (ahead) {
    if (ahead.dist < 48) cruise = 0; // stop behind the car ahead
    else cruise = Math.min(cruise, Math.max(60, Math.abs(ahead.car.speed || 0) * 0.9));
  }
  const status = driveRoute(G, car, dt, cruise);
  if (status === 'arrived') pickNewDestination(G, car);
}

// Keep traffic near the player: spawn up to the time-of-day target,
// despawn cars that drifted far away. The player's car and parked cars
// are never touched here.
export function updateTraffic(G, dt) {
  ensureTrafficState(G);
  const p = G.player;
  const target = trafficTargetCount(G);
  // Despawn traffic that is far from the player.
  if (p) {
    for (let i = G.traffic.length - 1; i >= 0; i--) {
      const car = G.traffic[i];
      if (Math.hypot(car.x - p.x, car.y - p.y) > 1300) {
        G.traffic.splice(i, 1);
        const idx = G.cars.indexOf(car);
        if (idx !== -1) G.cars.splice(idx, 1);
      }
    }
  }
  // Top up to the target count.
  let guard = 0;
  while (G.traffic.length < target && guard < 4) {
    guard++;
    spawnTrafficCar(G);
  }
  for (const car of G.traffic) updateTrafficCar(G, car, dt);
}

// Remove a traffic car from the traffic list (carjacking: the driver
// flees and the car leaves traffic). The car object stays in G.cars.
export function removeTrafficCar(G, car) {
  ensureTrafficState(G);
  const i = G.traffic.indexOf(car);
  if (i !== -1) G.traffic.splice(i, 1);
}

// Draw all traffic + parked cars. The player's car is drawn by the
// same pass (it lives in G.cars) with a white ground ring and a small
// direction arrow so the player is findable in one second.
export function drawCars(ctx, G, cam) {
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  const playerCar = G.player && G.player.car;
  for (const car of G.cars) {
    const x = car.x - px;
    const y = car.y - py;
    // Skip cars far off screen.
    if (x < -80 || x > (ctx.canvas ? ctx.canvas.width + 80 : 2000) ||
        y < -80 || y > (ctx.canvas ? ctx.canvas.height + 80 : 2000)) {
      continue;
    }
    if (car === playerCar) {
      // Thin white/yellow ground ring under the player's car.
      ctx.strokeStyle = 'rgba(255, 235, 120, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(x, y, 30, 18, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(car.angle);
    // South-east shadow (sun from the north-west).
    ctx.fillStyle = 'rgba(40, 30, 90, 0.28)';
    ctx.fillRect(-16 + 5, -8 + 7, 36, 18);
    const body = car.wrecked ? '#3a3a3a' : (car.paint || car.color);
    ctx.fillStyle = body;
    // Car body: sedan 36x18, truck longer, sports lower.
    const len = car.type === 'truck' ? 48 : car.type === 'sports' ? 38 : 36;
    const wid = car.type === 'truck' ? 20 : 18;
    ctx.fillRect(-len / 2, -wid / 2, len, wid);
    // Windows.
    ctx.fillStyle = car.wrecked ? '#222' : '#bfe0f2';
    if (car.type === 'truck') {
      ctx.fillRect(len / 2 - 12, -wid / 2 + 3, 9, wid - 6);
    } else {
      ctx.fillRect(-4, -wid / 2 + 3, 12, wid - 6);
    }
    // Taxi checker stripe.
    if (car.type === 'taxi') {
      ctx.fillStyle = '#222';
      ctx.fillRect(-len / 2 + 4, -2, len - 8, 4);
      ctx.fillStyle = '#ffd76a';
      ctx.fillRect(-len / 2 + 4, -wid / 2 - 2, len - 8, 3);
    }
    // Headlights at night.
    const night = (G.time && G.time.night) || 0;
    if (night > 0.4 && !car.wrecked) {
      ctx.fillStyle = 'rgba(255, 244, 180, 0.95)';
      ctx.fillRect(len / 2 - 2, -wid / 2 + 2, 3, 4);
      ctx.fillRect(len / 2 - 2, wid / 2 - 6, 3, 4);
    }
    ctx.restore();
    if (car === playerCar) {
      // Small direction arrow ahead of the player's car.
      const ax = x + Math.cos(car.angle) * 44;
      const ay = y + Math.sin(car.angle) * 44;
      ctx.fillStyle = 'rgba(255, 235, 120, 0.95)';
      ctx.beginPath();
      ctx.moveTo(ax + Math.cos(car.angle) * 10, ay + Math.sin(car.angle) * 10);
      ctx.lineTo(ax + Math.cos(car.angle + 2.6) * 8, ay + Math.sin(car.angle + 2.6) * 8);
      ctx.lineTo(ax + Math.cos(car.angle - 2.6) * 8, ay + Math.sin(car.angle - 2.6) * 8);
      ctx.closePath();
      ctx.fill();
    }
    // Smoke over a wrecked / badly damaged car.
    if (car.wrecked || car.health < 30) {
      ctx.fillStyle = 'rgba(120, 120, 120, 0.55)';
      ctx.beginPath();
      ctx.arc(x - 6, y - 8, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
