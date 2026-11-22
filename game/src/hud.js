// hud.js — every HUD element, drawn on canvas (render.js calls
// drawHud(ctx, G); the canvas size comes from ctx.canvas). Spec section
// 1 + brief amendment A5 minimum sizes, all for the 1/5-scale judge
// view: wanted stars 40px each, objective banner 28px bold over a dark
// scrim at lower-left, minimap 180px at upper-right, thick health bar,
// big cash / speed / ammo, current weapon name + ammo large, and the
// radio station name with an animated equalizer. The radio name comes
// from radio.js currentStationName — the same source as the
// #radio-station DOM badge radio.js writes — so canvas and badge can
// never disagree. Every text has a dark outline so it reads over the
// city. Nothing here throws on a partial G (the Node harness calls
// drawHud with a stub canvas and a minimal state).
import { starsFromHeat } from './police.js';
import { missionObjectiveText } from './missions.js';
import { currentStationName } from './radio.js';
import { currentWeaponDef, currentAmmo } from './weapons.js';
import { ROADS, WORLD_SIZE } from './config.js';

// Minimum sizes from the brief (A5): stars >=36px, banner >=28px bold,
// minimap >=180px, health bar >=14px thick, cash/speed/ammo >=24px.
export const HUD_STAR_SIZE = 40;
export const HUD_STAR_GAP = 8;
export const HUD_MINIMAP_SIZE = 180;
export const HUD_BANNER_FONT_PX = 28;
export const HUD_HEALTH_HEIGHT = 18;
export const HUD_CASH_FONT_PX = 28;

function hasCtx(ctx) {
  return !!ctx && typeof ctx.fillRect === 'function' && typeof ctx.fillText === 'function';
}

function canvasSize(ctx) {
  const c = ctx && ctx.canvas;
  return {
    w: (c && c.width) || 1280,
    h: (c && c.height) || 800,
  };
}

// Text with a dark outline, so it reads over any background.
function outlinedText(ctx, text, x, y, font, fill, align, baseline) {
  ctx.font = font;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = baseline || 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillText(text, x, y);
}

function starPath(ctx, cx, cy, rOuter, rInner) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// Wanted stars, upper-left, 40px each. Gold while earned, dark while
// empty; 4-5 stars glow red (red is reserved for danger).
export function drawWantedStars(ctx, G, x, y) {
  if (!hasCtx(ctx)) return;
  const stars = typeof G.stars === 'number' ? G.stars : starsFromHeat(G.heat || 0);
  const ox = typeof x === 'number' ? x : 16;
  const oy = typeof y === 'number' ? y : 14;
  const size = HUD_STAR_SIZE;
  for (let i = 0; i < 5; i++) {
    const cx = ox + size / 2 + i * (size + HUD_STAR_GAP);
    const cy = oy + size / 2;
    starPath(ctx, cx, cy, size / 2, size / 5);
    if (i < stars) {
      ctx.fillStyle = stars >= 4 ? '#ff5a3c' : '#ffd23a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.lineWidth = 3;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

// Thick health bar under the stars, with a numeric readout.
export function drawHealthBar(ctx, G, x, y) {
  if (!hasCtx(ctx)) return;
  const p = G.player || {};
  const hp = Math.max(0, p.health ?? 100);
  const maxHp = p.maxHealth || 100;
  const ox = typeof x === 'number' ? x : 16;
  const oy = typeof y === 'number' ? y : 62;
  const w = 240;
  const h = HUD_HEALTH_HEIGHT;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(ox, oy, w, h);
  ctx.fillStyle = hp > 50 ? '#3aa655' : hp > 25 ? '#e8a13a' : '#d83a3a';
  ctx.fillRect(ox + 2, oy + 2, (w - 4) * Math.max(0, Math.min(1, hp / maxHp)), h - 4);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, w, h);
  outlinedText(ctx, `HP ${Math.round(hp)}`, ox + w + 10, oy + h / 2, 'bold 18px sans-serif', '#ffffff', 'left', 'middle');
}

// Objective banner, lower-left: bold 28px text over a dark scrim, so
// it stays readable over the city. Wraps to two lines when long.
export function drawObjectiveBanner(ctx, G, width, height) {
  if (!hasCtx(ctx)) return;
  const W = width || canvasSize(ctx).w;
  const H = height || canvasSize(ctx).h;
  const text = missionObjectiveText(G);
  if (!text) return;
  const font = `bold ${HUD_BANNER_FONT_PX}px sans-serif`;
  const maxW = Math.min(640, W - 32);
  ctx.font = font;
  const words = String(text).split(' ');
  const lines = [''];
  for (const word of words) {
    const trial = lines[lines.length - 1] ? `${lines[lines.length - 1]} ${word}` : word;
    const w = ctx.measureText ? ctx.measureText(trial).width : trial.length * 14;
    if (w > maxW - 32 && lines[lines.length - 1]) lines.push(word);
    else lines[lines.length - 1] = trial;
  }
  const shown = lines.slice(0, 2);
  const boxH = 20 + shown.length * 34;
  const boxW = Math.min(maxW, Math.max(...shown.map((l) => (ctx.measureText ? ctx.measureText(l).width : l.length * 14))) + 32);
  const bx = 16;
  const by = H - 16 - boxH;
  ctx.fillStyle = 'rgba(8, 10, 18, 0.72)';
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.strokeStyle = 'rgba(255, 215, 106, 0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, boxW, boxH);
  shown.forEach((line, i) => {
    outlinedText(ctx, line, bx + 16, by + 22 + i * 34, font, '#ffffff', 'left', 'middle');
  });
}

// Minimap, upper-right: dark panel, bright roads, water strip, player
// arrow (white), police (red), mission marker (yellow diamond),
// enemies (orange while a shootout runs), garage (green) and Spray
// Shop (cyan) dots.
export function drawMinimap(ctx, G, x, y, size) {
  if (!hasCtx(ctx)) return;
  const s = size || HUD_MINIMAP_SIZE;
  const ox = typeof x === 'number' ? x : 0;
  const oy = typeof y === 'number' ? y : 0;
  const scale = s / WORLD_SIZE;
  ctx.fillStyle = 'rgba(8, 10, 18, 0.85)';
  ctx.fillRect(ox, oy, s, s);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(ox, oy, s, s);
  const mx = (wx) => ox + wx * scale;
  const my = (wy) => oy + wy * scale;
  // Water strip at the east edge.
  ctx.fillStyle = '#2a6db0';
  ctx.fillRect(mx(3060), oy, s - 3060 * scale, s);
  // Roads.
  ctx.strokeStyle = '#9a9a8a';
  ctx.lineWidth = 3;
  for (const r of ROADS) {
    ctx.beginPath();
    ctx.moveTo(mx(r), oy);
    ctx.lineTo(mx(r), oy + s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, my(r));
    ctx.lineTo(ox + s, my(r));
    ctx.stroke();
  }
  const dot = (wx, wy, color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(mx(wx), my(wy), r || 3, 0, Math.PI * 2);
    ctx.fill();
  };
  if (G.world && G.world.garage) dot(G.world.garage.x, G.world.garage.y, '#2ecc71', 4);
  if (G.world && G.world.sprayShop) dot(G.world.sprayShop.x, G.world.sprayShop.y, '#37c8e8', 4);
  // Mission marker: yellow diamond.
  const marker = G.mission && G.mission.marker;
  if (marker) {
    const cx = mx(marker.x);
    const cy = my(marker.y);
    ctx.fillStyle = '#ffd23a';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7);
    ctx.lineTo(cx + 7, cy);
    ctx.lineTo(cx, cy + 7);
    ctx.lineTo(cx - 7, cy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // Enemies, then police, then the player on top.
  for (const e of G.enemies || []) {
    if (!e.dead) dot(e.x, e.y, '#ff8a3c', 3);
  }
  if (G.police) {
    for (const cop of G.police.footCops || []) dot(cop.x, cop.y, '#ff2a2a', 3);
    for (const car of G.police.patrolCars || []) dot(car.x, car.y, '#ff2a2a', 4);
    for (const rb of G.police.roadblocks || []) dot(rb.x, rb.y, '#ff2a2a', 4);
  }
  const p = G.player;
  if (p) {
    const cx = mx(p.car ? p.car.x : p.x);
    const cy = my(p.car ? p.car.y : p.y);
    const a = p.angle || 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9);
    ctx.lineTo(cx + Math.cos(a + 2.5) * 7, cy + Math.sin(a + 2.5) * 7);
    ctx.lineTo(cx + Math.cos(a - 2.5) * 7, cy + Math.sin(a - 2.5) * 7);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Radio pill, top-centre: station name (same source as the DOM badge)
// plus an animated equalizer driven by G.radio.eqLevel.
function drawRadio(ctx, G, W) {
  if (!hasCtx(ctx)) return;
  const name = currentStationName(G);
  const t = (G.time && G.time.t) || 0;
  const eq = (G.radio && typeof G.radio.eqLevel === 'number') ? G.radio.eqLevel : 0;
  const font = 'bold 18px sans-serif';
  ctx.font = font;
  const nameW = ctx.measureText ? ctx.measureText(name).width : name.length * 10;
  const barsW = 10 * 7 + 6;
  const pillW = nameW + barsW + 30;
  const pillH = 34;
  const px = Math.round((W - pillW) / 2);
  const py = 44;
  ctx.fillStyle = 'rgba(8, 10, 18, 0.78)';
  ctx.fillRect(px, py, pillW, pillH);
  ctx.strokeStyle = 'rgba(255, 215, 106, 0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, pillW, pillH);
  outlinedText(ctx, `♪ ${name}`, px + 12, py + pillH / 2, font, '#ffd76a', 'left', 'middle');
  // Equalizer: 10 bars, heights animated by time and eqLevel.
  const bx0 = px + 12 + nameW + 14;
  for (let i = 0; i < 10; i++) {
    const wave = Math.abs(Math.sin(t * 6 + i * 0.9));
    const h = 4 + wave * (0.25 + eq * 0.75) * 20;
    const bx = bx0 + i * 7;
    ctx.fillStyle = i % 2 === 0 ? '#ffd76a' : '#37c8e8';
    ctx.fillRect(bx, py + pillH - 6 - h, 4, h);
  }
}

// Weapon name + ammo, speed — big, lower-right.
function drawWeaponAndSpeed(ctx, G, W, H) {
  if (!hasCtx(ctx)) return;
  const p = G.player || {};
  const def = currentWeaponDef(G);
  const ammo = currentAmmo(G);
  const rx = W - 16;
  let y = H - 30;
  outlinedText(ctx, `AMMO ${ammo}`, rx, y, 'bold 26px sans-serif', '#ffffff', 'right', 'middle');
  y -= 34;
  outlinedText(ctx, def ? def.name.toUpperCase() : 'PISTOL', rx, y, 'bold 28px sans-serif', '#ffd76a', 'right', 'middle');
  if (!p.onFoot && p.car) {
    y -= 38;
    const speed = Math.round(Math.abs(p.car.speed || 0));
    outlinedText(ctx, `${speed}`, rx, y, 'bold 32px sans-serif', '#ffffff', 'right', 'middle');
    outlinedText(ctx, 'SPEED', rx - 84, y, 'bold 16px sans-serif', '#bbbbbb', 'right', 'middle');
  }
}

// Cash, clock and day/night, upper-right (cash above the minimap).
function drawCashAndClock(ctx, G, W) {
  if (!hasCtx(ctx)) return;
  const p = G.player || {};
  const rx = W - 16;
  outlinedText(ctx, `$${p.cash || 0}`, rx, 28, `bold ${HUD_CASH_FONT_PX}px sans-serif`, '#ffffff', 'right', 'middle');
  const hour = (G.time && typeof G.time.hour === 'number') ? G.time.hour : 8;
  const hh = Math.floor(hour) % 24;
  const mm = Math.floor((hour % 1) * 60);
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const night = G.time && G.time.night > 0.5;
  outlinedText(ctx, `${clock} ${night ? 'NIGHT' : 'DAY'}`, rx, HUD_MINIMAP_SIZE + 48 + 22, 'bold 18px sans-serif', '#dddddd', 'right', 'middle');
}

// Transient mission message ("Ram hit 2/4!", "Package picked up") in
// the centre, while main.js keeps it alive (~3.5s).
function drawHudMessage(ctx, G, W) {
  if (!hasCtx(ctx)) return;
  const msg = G.hudMessage;
  if (!msg) return;
  const t = (G.time && G.time.t) || 0;
  if (G.hudMessageUntil && t > G.hudMessageUntil) return;
  const font = 'bold 22px sans-serif';
  ctx.font = font;
  const w = (ctx.measureText ? ctx.measureText(msg).width : msg.length * 11) + 32;
  const x = Math.round((W - w) / 2);
  const y = 96;
  ctx.fillStyle = 'rgba(8, 10, 18, 0.72)';
  ctx.fillRect(x, y, w, 36);
  ctx.strokeStyle = 'rgba(255, 215, 106, 0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, 36);
  outlinedText(ctx, msg, x + w / 2, y + 18, font, '#ffffff', 'center', 'middle');
}

// Full HUD: render.js calls drawHud(ctx, G). Width/height come from
// the canvas unless the caller passes them. Returns false when the
// context cannot draw (harness stub without canvas methods).
export function drawHud(ctx, G, cam, width, height) {
  if (!hasCtx(ctx) || !G) return false;
  const size = canvasSize(ctx);
  const W = width || size.w;
  const H = height || size.h;
  drawWantedStars(ctx, G, 16, 14);
  drawHealthBar(ctx, G, 16, 62);
  drawRadio(ctx, G, W);
  drawCashAndClock(ctx, G, W);
  drawMinimap(ctx, G, W - 16 - HUD_MINIMAP_SIZE, 48, HUD_MINIMAP_SIZE);
  drawObjectiveBanner(ctx, G, W, H);
  drawWeaponAndSpeed(ctx, G, W, H);
  drawHudMessage(ctx, G, W);
  return true;
}
