// render.js — Canvas 2D renderer for Crescent Bay. A PRE-RENDERED
// static layer (1600x1600 offscreen canvas, drawn once) holds the
// whole city; every frame paints only the dynamic entities on top.
// A full-city repaint every frame stalls software rendering — the
// static layer is what keeps the title screen at 60 FPS.
//
// PAINT ORDER FIX (v5 caveat): the waterfront blue water band
// (x > 3100) must stay visible — paint water FIRST, then sand/beach,
// then blocks/roads, so blocks/roads never cover the water.
// Buildings are 2.5D: roof + darker south/east sides, blue-purple
// shadows to the south-east, sun from the north-west.

import { WORLD_SIZE, ROADS, ROAD_WIDTH } from './config.js';

// The static layer is drawn at half scale: 1600x1600 for a 3200 world.
export const STATIC_SCALE = 0.5;
export const STATIC_SIZE = 1600;

// Build the pre-rendered static layer for a world. Returns an
// offscreen canvas (or null outside a browser).
export function createStaticLayer(world) {
  if (typeof document === 'undefined') return null;
  const layer = document.createElement('canvas');
  layer.width = STATIC_SIZE;
  layer.height = STATIC_SIZE;
  const c = layer.getContext('2d');
  const S = STATIC_SCALE;
  c.scale(S, S);

  // 1. WATER FIRST: the whole east band, so nothing can cover it.
  c.fillStyle = '#3f9fd8';
  c.fillRect(3060, 0, WORLD_SIZE - 3060, WORLD_SIZE);
  // Gentle wave stripes in the water.
  c.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  c.lineWidth = 3;
  for (let y = 60; y < WORLD_SIZE; y += 140) {
    c.beginPath();
    c.moveTo(3090, y);
    c.quadraticCurveTo(3130, y + 18, 3170, y);
    c.stroke();
  }

  // 2. SAND / BEACH next (3000-3060), then the land base.
  c.fillStyle = '#e8d5a0';
  c.fillRect(3000, 0, 60, WORLD_SIZE);
  c.fillStyle = '#b8a67e';
  c.fillRect(3052, 0, 8, WORLD_SIZE);
  // Land base: warm neutral ground for the whole city.
  c.fillStyle = '#c9b896';
  c.fillRect(0, 0, 3000, WORLD_SIZE);

  // 3. District ground tints per block (low contrast, low saturation).
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const x0 = ROADS[i] + 32;
      const y0 = ROADS[j] + 32;
      const w = ROADS[i + 1] - ROADS[i] - 64;
      const h = ROADS[j + 1] - ROADS[j] - 64;
      const d = world.districtAt ? world.districtAt((x0 + w / 2), (y0 + h / 2)) : null;
      const flavour = d ? d.flavour : 'houses';
      c.fillStyle = flavour === 'glass' ? '#b9c4cc'
        : flavour === 'brick' ? '#c4a88f'
        : flavour === 'sand' ? '#e0cfa0'
        : flavour === 'industrial' ? '#a9a49b'
        : '#c2b28a';
      c.fillRect(x0, y0, w, h);
    }
  }

  // 4. Parks: green ground + trees (drawn under buildings).
  for (const park of world.parks || []) {
    c.fillStyle = '#7fae62';
    c.fillRect(park.x, park.y, park.w, park.h);
    for (const t of park.trees) {
      c.fillStyle = 'rgba(40, 30, 90, 0.25)';
      c.beginPath();
      c.ellipse(t.x + 6, t.y + 8, t.r, t.r * 0.5, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#4a7a3a';
      c.beginPath();
      c.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#6a9a4a';
      c.beginPath();
      c.arc(t.x - 3, t.y - 3, t.r * 0.6, 0, Math.PI * 2);
      c.fill();
    }
  }

  // 5. Sidewalks: lighter strips along every road.
  c.fillStyle = '#d8cbb2';
  for (const r of ROADS) {
    c.fillRect(0, r - ROAD_WIDTH / 2 - 14, 3000, 14);
    c.fillRect(0, r + ROAD_WIDTH / 2, 3000, 14);
    c.fillRect(r - ROAD_WIDTH / 2 - 14, 0, 14, WORLD_SIZE);
    c.fillRect(r + ROAD_WIDTH / 2, 0, 14, WORLD_SIZE);
  }

  // 6. Roads: warm asphalt with centre dashes.
  c.fillStyle = '#5e5a55';
  for (const r of ROADS) {
    c.fillRect(0, r - ROAD_WIDTH / 2, 3000, ROAD_WIDTH);
    c.fillRect(r - ROAD_WIDTH / 2, 0, ROAD_WIDTH, WORLD_SIZE);
  }
  c.strokeStyle = '#e8d76a';
  c.lineWidth = 3;
  c.setLineDash([26, 22]);
  for (const r of ROADS) {
    c.beginPath();
    c.moveTo(0, r);
    c.lineTo(3000, r);
    c.stroke();
    c.beginPath();
    c.moveTo(r, 0);
    c.lineTo(r, WORLD_SIZE);
    c.stroke();
  }
  c.setLineDash([]);

  // 7. Marina pier east: wooden planks reaching into the water.
  const marina = world.marina || { x: 3000, y: 1400 };
  c.fillStyle = '#8a6a42';
  c.fillRect(3000, marina.y - 16, 120, 32);
  c.fillStyle = '#a87f52';
  for (let x = 3010; x < 3110; x += 20) {
    c.fillRect(x, marina.y - 16, 10, 32);
  }
  // Moored boats: small white hulls beside the pier.
  c.fillStyle = '#f2f2f2';
  c.fillRect(3060, marina.y - 52, 44, 14);
  c.fillRect(3060, marina.y + 38, 44, 14);

  // 8. Buildings, 2.5D: blue-purple shadow to the south-east, darker
  // south/east sides, roof on top. Sun comes from the north-west.
  for (const b of world.buildings) {
    // Shadow.
    c.fillStyle = 'rgba(64, 48, 140, 0.28)';
    const sh = Math.min(26, b.hgt * 0.45);
    c.fillRect(b.x + 8, b.y + 10, b.w, b.h);
    c.fillRect(b.x + sh, b.y + b.h, b.w, sh * 0.5);
    // South + east sides (darker).
    c.fillStyle = shade(b.wall, -28);
    c.fillRect(b.x, b.y + b.h - 8, b.w, 8);
    c.fillRect(b.x + b.w - 8, b.y, 8, b.h);
    // Walls.
    c.fillStyle = b.wall;
    c.fillRect(b.x, b.y, b.w, b.h);
    // Roof (slightly inset, lighter than the walls).
    c.fillStyle = b.roof;
    c.fillRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
    // Roof detail: glass towers get a lighter skylight strip.
    if (b.flavour === 'glass') {
      c.fillStyle = 'rgba(255, 255, 255, 0.35)';
      c.fillRect(b.x + 10, b.y + 10, b.w - 20, 8);
      c.fillRect(b.x + 10, b.y + 10, 8, b.h - 20);
    } else if (b.flavour === 'houses') {
      c.fillStyle = 'rgba(0, 0, 0, 0.18)';
      c.fillRect(b.x + b.w / 2 - 2, b.y + 6, 4, b.h - 12);
    }
    // Windows on the roof edge for tall towers.
    if (b.hgt > 40) {
      c.fillStyle = 'rgba(255, 244, 180, 0.5)';
      for (let wx = b.x + 16; wx < b.x + b.w - 16; wx += 26) {
        c.fillRect(wx, b.y + b.h - 14, 12, 6);
      }
    }
  }

  // 9. Landmark pads: spray shop + garage aprons on the ground.
  drawLandmarkPad(c, world.sprayShop, '#e8a13a', 'SPRAY');
  drawLandmarkPad(c, world.garage, '#ffd76a', 'GARAGE');

  return layer;
}

// Darken (negative) or lighten (positive) a #rrggbb colour.
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amount));
  return `rgb(${r},${g},${b})`;
}

function drawLandmarkPad(c, place, color, label) {
  if (!place) return;
  c.fillStyle = 'rgba(30, 30, 40, 0.55)';
  c.beginPath();
  c.arc(place.x, place.y, (place.r || 60) + 8, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = color;
  c.lineWidth = 4;
  c.beginPath();
  c.arc(place.x, place.y, place.r || 60, 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = color;
  c.font = 'bold 22px sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(label, place.x, place.y);
}

// --- minimap ---------------------------------------------------------------

// Pre-render the minimap base once: dark panel, bright roads, water.
export function createMinimap(world, size) {
  if (typeof document === 'undefined') return null;
  const s = size || 180;
  const map = document.createElement('canvas');
  map.width = s;
  map.height = s;
  const c = map.getContext('2d');
  const k = s / WORLD_SIZE;
  c.fillStyle = 'rgba(20, 22, 34, 0.9)';
  c.fillRect(0, 0, s, s);
  c.fillStyle = '#3f9fd8';
  c.fillRect(3060 * k, 0, (WORLD_SIZE - 3060) * k, s);
  c.strokeStyle = '#cfc4a8';
  c.lineWidth = 2;
  for (const r of ROADS) {
    c.beginPath();
    c.moveTo(0, r * k);
    c.lineTo(3000 * k, r * k);
    c.stroke();
    c.beginPath();
    c.moveTo(r * k, 0);
    c.lineTo(r * k, s);
    c.stroke();
  }
  return map;
}

// --- scene -----------------------------------------------------------------

// Draw the whole frame: static layer, then dynamic entities in paint
// order (ground markers, pickups/crates, cover, cars, pedestrians,
// player, police, helicopter, particles), then night lighting, then
// the HUD fallback when no hud system is wired in.
export function drawScene(ctx, G, systems) {
  const cam = G.camera || { x: 0, y: 0 };
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Static layer, scaled from 1600 back to 3200 world units.
  if (G.staticLayer) {
    ctx.drawImage(
      G.staticLayer,
      cam.x * STATIC_SCALE, cam.y * STATIC_SCALE, W * STATIC_SCALE, H * STATIC_SCALE,
      0, 0, W, H,
    );
  }

  const sys = systems || {};
  // Mission marker: yellow diamond + beacon column.
  const marker = G.mission && G.mission.marker;
  if (marker) {
    const mx = marker.x - cam.x;
    const my = marker.y - cam.y;
    const pulse = 1 + Math.sin((G.time ? G.time.t : 0) * 4) * 0.15;
    ctx.fillStyle = 'rgba(255, 215, 106, 0.25)';
    ctx.fillRect(mx - 3, my - 260, 6, 260);
    ctx.fillStyle = '#ffd76a';
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.PI / 4);
    const s = 16 * pulse;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
    ctx.strokeStyle = '#7a5a00';
    ctx.lineWidth = 3;
    ctx.strokeRect(mx - 10, my - 10, 20, 20);
  }

  // Spray Shop heat drain ring (the repaint garage that clears heat).
  const shop = G.world && G.world.sprayShop;
  if (shop) {
    const sx = shop.x - cam.x;
    const sy = shop.y - cam.y;
    ctx.strokeStyle = 'rgba(232, 161, 58, 0.7)';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 8]);
    ctx.beginPath();
    ctx.arc(sx, sy, shop.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (sys.garage && sys.garage.drawGarageZone) sys.garage.drawGarageZone(ctx, G, cam);
  if (sys.weapons && sys.weapons.drawWeaponCrates) sys.weapons.drawWeaponCrates(ctx, G, cam);
  if (sys.combat && sys.combat.drawCombat) sys.combat.drawCombat(ctx, G, cam);
  if (sys.traffic && sys.traffic.drawCars) sys.traffic.drawCars(ctx, G, cam);
  if (sys.pedestrians && sys.pedestrians.drawPedestrians) sys.pedestrians.drawPedestrians(ctx, G, cam);
  if (sys.player && sys.player.drawPlayer) sys.player.drawPlayer(ctx, G, cam);
  if (sys.police && sys.police.drawPolice) sys.police.drawPolice(ctx, G, cam);
  if (sys.helicopter && sys.helicopter.drawHelicopter) sys.helicopter.drawHelicopter(ctx, G, cam);

  drawParticles(ctx, G, cam);

  // Night lighting: a dark blue overlay, then pools of light cut back
  // in around street lamps and the player's headlights.
  drawNightLighting(ctx, G, cam);

  // HUD: the wired hud system draws it when present; otherwise the
  // built-in fallback below (base game must run standalone now).
  if (sys.hud && sys.hud.drawHud) sys.hud.drawHud(ctx, G);
  else drawHudFallback(ctx, G);
}

// Particles: muzzle flashes, hit sparks, smoke, skid marks.
export function drawParticles(ctx, G, cam) {
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  for (const pt of G.particles || []) {
    const x = pt.x - px;
    const y = pt.y - py;
    const lifeFrac = Math.max(0, pt.life / (pt.maxLife || 1));
    if (pt.kind === 'muzzle') {
      ctx.fillStyle = `rgba(255, 240, 150, ${lifeFrac})`;
      ctx.beginPath();
      ctx.arc(x, y, 12 * lifeFrac + 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (pt.kind === 'spark' || pt.kind === 'hit') {
      ctx.fillStyle = pt.kind === 'hit'
        ? `rgba(255, 120, 60, ${lifeFrac})`
        : `rgba(255, 230, 120, ${lifeFrac})`;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (pt.kind === 'smoke') {
      ctx.fillStyle = `rgba(120, 120, 120, ${0.55 * lifeFrac})`;
      ctx.beginPath();
      ctx.arc(x, y, 8 + (1 - lifeFrac) * 10, 0, Math.PI * 2);
      ctx.fill();
    } else if (pt.kind === 'skid') {
      ctx.strokeStyle = `rgba(20, 20, 20, ${0.7 * lifeFrac})`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(pt.angle || 0) * 14, y - Math.sin(pt.angle || 0) * 14);
      ctx.lineTo(x + Math.cos(pt.angle || 0) * 14, y + Math.sin(pt.angle || 0) * 14);
      ctx.stroke();
    }
  }
}

// Night overlay + light pools. Headlight cones in front of the
// player's car, warm pools under nearby street lamps.
function drawNightLighting(ctx, G, cam) {
  const night = (G.time && G.time.night) || 0;
  if (night <= 0.02) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.fillStyle = `rgba(10, 14, 42, ${0.55 * night})`;
  ctx.fillRect(0, 0, W, H);
  // Cut light pools back in with 'destination-out' on a scratch
  // canvas is expensive; instead paint additive warm radial pools.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pool = (wx, wy, radius, alpha) => {
    const x = wx - cam.x;
    const y = wy - cam.y;
    if (x < -radius || x > W + radius || y < -radius || y > H + radius) return;
    const grad = ctx.createRadialGradient(x, y, 6, x, y, radius);
    grad.addColorStop(0, `rgba(255, 220, 140, ${alpha * night})`);
    grad.addColorStop(1, 'rgba(255, 220, 140, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  // Street-lamp pools near the camera.
  for (const lamp of (G.world && G.world.lamps) || []) {
    pool(lamp.x, lamp.y, 130, 0.35);
  }
  // Headlights: a pool ahead of the player's car (and of any car).
  for (const car of G.cars || []) {
    if (car.wrecked) continue;
    const hx = car.x + Math.cos(car.angle) * 90;
    const hy = car.y + Math.sin(car.angle) * 90;
    pool(hx, hy, 120, 0.5);
  }
  ctx.restore();
}

// --- HUD fallback (used until hud.js lands in batch B-3) ------------------
// Sizes follow the brief: stars >=36px, objective banner >=28px bold
// on a dark scrim lower-left, minimap >=180px upper-right, thick
// health bar, big cash/speed/ammo. All text has a dark outline.

export function drawHudFallback(ctx, G) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const p = G.player || {};
  ctx.textBaseline = 'middle';

  // Wanted stars, upper-left, >=36px each.
  const stars = G.stars || 0;
  ctx.font = '36px sans-serif';
  ctx.textAlign = 'left';
  for (let i = 0; i < 5; i++) {
    const x = 16 + i * 40;
    const y = 30;
    ctx.fillStyle = i < stars ? '#ffd23a' : 'rgba(255, 255, 255, 0.25)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 4;
    ctx.strokeText('★', x, y);
    ctx.fillText('★', x, y);
  }

  // Health bar, thick (>=14px), under the stars.
  const hp = Math.max(0, p.health ?? 100);
  const maxHp = p.maxHealth || 100;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(16, 56, 220, 18);
  ctx.fillStyle = hp > 50 ? '#3aa655' : hp > 25 ? '#e8a13a' : '#d83a3a';
  ctx.fillRect(18, 58, 216 * (hp / maxHp), 14);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 56, 220, 18);

  // Cash, big, upper-right above the minimap.
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.lineWidth = 4;
  ctx.strokeText(`$${p.cash || 0}`, W - 16, 28);
  ctx.fillText(`$${p.cash || 0}`, W - 16, 28);

  // Minimap, >=180px, upper-right under the cash.
  drawMinimapFallback(ctx, G, W - 196, 48, 180);

  // Clock + radio station, upper-right under the minimap.
  const hour = (G.time && typeof G.time.hour === 'number') ? G.time.hour : 8;
  const hh = Math.floor(hour) % 24;
  const mm = Math.floor((hour % 1) * 60);
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const station = G.radio && G.radio.station !== undefined
    ? ['Bay FM', 'Harbor Jazz', 'Crescent Rock'][G.radio.station] || 'Bay FM'
    : 'Bay FM';
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'right';
  ctx.strokeText(`${clock}  ·  ${station}`, W - 16, 246);
  ctx.fillText(`${clock}  ·  ${station}`, W - 16, 246);

  // Objective banner: >=28px bold on a dark scrim, lower-left.
  const objective = objectiveText(G);
  if (objective) {
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'left';
    const tw = ctx.measureText(objective).width;
    ctx.fillStyle = 'rgba(10, 12, 22, 0.72)';
    ctx.fillRect(12, H - 64, tw + 28, 48);
    ctx.fillStyle = '#ffd76a';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 4;
    ctx.strokeText(objective, 26, H - 40);
    ctx.fillText(objective, 26, H - 40);
  }

  // Speed + weapon/ammo, big, lower-right.
  const speed = p.car ? Math.round(Math.abs(p.car.speed || 0)) : Math.round(p.speed || 0);
  const weapon = G.weapons ? (G.weapons.current || 'pistol') : 'pistol';
  const ammo = G.weapons && G.weapons.ammo ? (G.weapons.ammo[weapon] || 0) : 0;
  const wName = weapon === 'pistol' ? 'Pistol' : weapon === 'smg' ? 'SMG' : 'Shotgun';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'right';
  const speedText = p.car ? `${speed} km/h` : `${wName} · ${ammo}`;
  const ammoText = p.car ? `${wName} · ${ammo}` : '';
  ctx.strokeText(speedText, W - 16, H - 40);
  ctx.fillText(speedText, W - 16, H - 40);
  if (ammoText) {
    ctx.font = '22px sans-serif';
    ctx.strokeText(ammoText, W - 16, H - 72);
    ctx.fillText(ammoText, W - 16, H - 72);
  }

  // Transient HUD message (pickups, mission events), centre-top.
  if (G.hudMessage && G.hudMessageUntil && (G.time ? G.time.t : 0) < G.hudMessageUntil) {
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 4;
    ctx.strokeText(G.hudMessage, W / 2, 92);
    ctx.fillText(G.hudMessage, W / 2, 92);
  }
}

function objectiveText(G) {
  if (G.systems && G.systems.missions && G.systems.missions.missionObjectiveText) {
    return G.systems.missions.missionObjectiveText(G);
  }
  const m = G.mission;
  if (!m || !m.id) return 'Free roam — visit the Fixer Garage for work';
  return `${m.id.toUpperCase()} — objective`;
}

// Minimap fallback: pre-rendered base + live dots (player white,
// police red, mission marker yellow diamond, nearby cars grey).
function drawMinimapFallback(ctx, G, x, y, size) {
  if (!G.minimapLayer) G.minimapLayer = createMinimap(G.world, size);
  if (G.minimapLayer) ctx.drawImage(G.minimapLayer, x, y);
  else {
    ctx.fillStyle = 'rgba(20, 22, 34, 0.9)';
    ctx.fillRect(x, y, size, size);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  const k = size / WORLD_SIZE;
  const dot = (wx, wy, color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + wx * k, y + wy * k, r, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const car of G.cars || []) {
    if (car === (G.player && G.player.car)) continue;
    dot(car.x, car.y, '#9a9a9a', 2);
  }
  if (G.police) {
    for (const cop of G.police.footCops || []) dot(cop.x, cop.y, '#ff2a2a', 3);
    for (const car of G.police.patrolCars || []) dot(car.x, car.y, '#ff2a2a', 3);
  }
  const marker = G.mission && G.mission.marker;
  if (marker) {
    ctx.fillStyle = '#ffd76a';
    const mx = x + marker.x * k;
    const my = y + marker.y * k;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-5, -5, 10, 10);
    ctx.restore();
  }
  const p = G.player;
  if (p) {
    // Player arrow: white triangle pointing along the facing.
    const px = x + p.x * k;
    const py = y + p.y * k;
    ctx.fillStyle = '#ffffff';
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(p.angle || 0);
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
