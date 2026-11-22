// helicopter.js — police helicopter. Spawns at 3+ stars and in m9/m12
// by mission script. It flies (no road constraint), shadows Rook, is
// faster than any car, and does NOT shoot. Its spotlight follows Rook and
// BLOCKS heat decay while it is on Rook — keyed on spotlightOnPlayer,
// never on the helicopter merely being active. Rook can shoot it down:
// enough damage makes it smoke and retreat for 20s; it returns if wanted
// is still 3+. Below 3 stars it leaves.
export const HELI_SPAWN_STARS = 3;
export const HELI_SPEED = 620;
export const HELI_RETREAT_SECONDS = 20;
export const HELI_DAMAGE_TO_RETREAT = 100;
export const HELI_SPOTLIGHT_RADIUS = 130;

export function createHelicopterState() {
  return {
    active: false, x: 0, y: 0, angle: 0,
    state: 'off', // off | shadowing | smoking | retreating | leaving
    damage: 0, retreatTimer: 0, rotor: 0, spotlightOnPlayer: false,
    forced: false, smokeTimer: 0,
  };
}

export function ensureHelicopterState(G) {
  if (!G.helicopter) G.helicopter = createHelicopterState();
  return G.helicopter;
}

// Mission script call: keep the helicopter up for this mission even if
// the star count would not spawn it on its own (m9, m12).
export function forceHelicopter(G, on) {
  ensureHelicopterState(G);
  G.helicopter.forced = !!on;
  if (on && !G.helicopter.active) spawnHelicopter(G);
  if (!on && G.helicopter.active && (G.stars || 0) < HELI_SPAWN_STARS) {
    G.helicopter.state = 'leaving';
  }
}

export function spawnHelicopter(G) {
  ensureHelicopterState(G);
  const p = G.player;
  const h = G.helicopter;
  h.active = true;
  h.state = 'shadowing';
  h.damage = 0;
  h.retreatTimer = 0;
  h.spotlightOnPlayer = true;
  // Appear ahead of Rook, high above the road.
  h.x = p.x + 260;
  h.y = p.y - 260;
  h.angle = Math.atan2(p.y - h.y, p.x - h.x);
  if (G.audio) G.audio.play && G.audio.play('heli');
  return h;
}

export function takeHelicopterDamage(G, amount) {
  ensureHelicopterState(G);
  const h = G.helicopter;
  if (!h.active) return;
  if (h.state === 'retreating' || h.state === 'leaving') return;
  h.damage += amount;
  if (h.damage >= HELI_DAMAGE_TO_RETREAT) {
    h.state = 'smoking';
    h.smokeTimer = 0;
    h.retreatTimer = HELI_RETREAT_SECONDS;
    h.spotlightOnPlayer = false;
    if (G.audio) G.audio.play && G.audio.play('heliHit');
  }
}

export function updateHelicopter(G, dt) {
  ensureHelicopterState(G);
  const h = G.helicopter;
  const p = G.player;
  if (!p) return;
  h.rotor += dt * 28;
  const stars = G.stars || 0;
  const wanted = stars >= HELI_SPAWN_STARS || h.forced;

  if (!h.active) {
    if (wanted) spawnHelicopter(G);
    else { h.spotlightOnPlayer = false; return; }
  }

  if (h.state === 'smoking' || h.state === 'retreating') {
    h.retreatTimer -= dt;
    h.smokeTimer += dt;
    h.spotlightOnPlayer = false;
    // Retreat away from Rook while smoking.
    const away = Math.atan2(h.y - p.y, h.x - p.x);
    h.x += Math.cos(away) * HELI_SPEED * 0.7 * dt;
    h.y += Math.sin(away) * HELI_SPEED * 0.7 * dt;
    h.angle = away;
    if (h.retreatTimer <= 0) {
      h.damage = 0;
      if (wanted) {
        h.state = 'shadowing';
        h.x = p.x + 260;
        h.y = p.y - 260;
      } else {
        h.state = 'leaving';
      }
    }
    return;
  }

  if (h.state === 'leaving') {
    const away = Math.atan2(h.y - p.y, h.x - p.x);
    h.x += Math.cos(away) * HELI_SPEED * dt;
    h.y += Math.sin(away) * HELI_SPEED * dt;
    h.angle = away;
    h.spotlightOnPlayer = false;
    if (Math.hypot(h.x - p.x, h.y - p.y) > 1400) {
      h.active = false;
      h.state = 'off';
    }
    return;
  }

  // Shadowing: fly straight at Rook (no roads up here), faster than any
  // car, and hover just above him. The spotlight cone on the ground
  // follows Rook while the helicopter is overhead.
  const dx = p.x - h.x;
  const dy = p.y - h.y;
  const d = Math.hypot(dx, dy);
  h.angle = Math.atan2(dy, dx);
  if (d > 90) {
    const step = Math.min(d - 60, HELI_SPEED * dt);
    h.x += (dx / d) * step;
    h.y += (dy / d) * step;
  }
  // Spotlight is on Rook while shadowing and close overhead.
  h.spotlightOnPlayer = d < 320;
  if (!wanted) {
    h.state = 'leaving';
    h.spotlightOnPlayer = false;
  }
}

export function drawHelicopter(ctx, G, cam) {
  ensureHelicopterState(G);
  const h = G.helicopter;
  if (!h.active) return;
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  const p = G.player;
  // Spotlight cone / circle on the ground follows Rook.
  if (h.spotlightOnPlayer && p) {
    const sx = p.x - px;
    const sy = p.y - py;
    const grad = ctx.createRadialGradient(sx, sy, 10, sx, sy, HELI_SPOTLIGHT_RADIUS);
    grad.addColorStop(0, 'rgba(255, 244, 180, 0.55)');
    grad.addColorStop(1, 'rgba(255, 244, 180, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, HELI_SPOTLIGHT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    // Beam from the helicopter down to the lit circle.
    ctx.strokeStyle = 'rgba(255, 244, 180, 0.25)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(h.x - px, h.y - py);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
  const x = h.x - px;
  const y = h.y - py;
  // Ground shadow, offset south-east (sun from the north-west).
  ctx.fillStyle = 'rgba(40, 30, 90, 0.35)';
  ctx.beginPath();
  ctx.ellipse(x + 18, y + 22, 34, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  // Body.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(h.angle);
  ctx.fillStyle = '#1c2f6e';
  ctx.fillRect(-26, -10, 52, 20);
  ctx.fillStyle = '#dfe6ff';
  ctx.fillRect(12, -8, 12, 16);
  ctx.fillStyle = '#e33';
  ctx.fillRect(-26, -10, 10, 5);
  // Rotor blur: two crossing translucent bars spinning fast.
  ctx.save();
  ctx.rotate(h.rotor);
  ctx.fillStyle = 'rgba(220, 220, 220, 0.45)';
  ctx.fillRect(-44, -2, 88, 4);
  ctx.fillRect(-2, -44, 4, 88);
  ctx.restore();
  ctx.restore();
  // Smoke while damaged and retreating.
  if (h.state === 'smoking' || h.state === 'retreating') {
    if (G.particles) {
      G.particles.push({ kind: 'smoke', x: h.x, y: h.y, life: 0.6, maxLife: 0.6,
        vx: 0, vy: -20 });
    }
    ctx.fillStyle = 'rgba(120, 120, 120, 0.6)';
    ctx.beginPath();
    ctx.arc(x - 20, y + 8, 10 + Math.sin(h.smokeTimer * 9) * 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
