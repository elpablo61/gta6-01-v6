// combat.js — shooting, bullets, enemy AI, pickups, cover.
// Enemies use the pistol only and have 36 HP; the pistol deals 18, so
// two hits drop one enemy. Objectives are conditions, never kill counts.
import { WEAPON_DEFS } from './weapons.js';

export const ENEMY_HP = 36;
export const ENEMY_PISTOL_DAMAGE = 18;
export const ENEMY_SHOOT_INTERVAL = 0.9;
export const ENEMY_SHOOT_RANGE = 300;
export const ENEMY_MOVE_RANGE = 240;

export function ensureCombatState(G) {
  if (!Array.isArray(G.bullets)) G.bullets = [];
  if (!Array.isArray(G.enemies)) G.enemies = [];
  if (!Array.isArray(G.pickups)) G.pickups = [];
  if (!Array.isArray(G.cover)) G.cover = [];
  if (!Array.isArray(G.particles)) G.particles = [];
  return G;
}

export function spawnEnemy(G, x, y, opts) {
  ensureCombatState(G);
  const o = opts || {};
  const enemy = {
    x, y, hp: o.hp || ENEMY_HP, maxHp: o.hp || ENEMY_HP,
    angle: 0, state: 'idle', shootTimer: 0.5 + (G.rng ? G.rng() : Math.random()) * 0.5,
    targetX: x, targetY: y, speed: o.speed || 130,
    arena: o.arena || null, dead: false,
  };
  G.enemies.push(enemy);
  return enemy;
}

export function spawnCover(G, x, y, w, h) {
  ensureCombatState(G);
  const c = { x, y, w: w || 90, h: h || 26 };
  G.cover.push(c);
  return c;
}

export function spawnArenaCover(G, cx, cy) {
  ensureCombatState(G);
  spawnCover(G, cx - 140, cy - 110, 110, 26);
  spawnCover(G, cx + 40, cy - 110, 110, 26);
  spawnCover(G, cx - 140, cy + 90, 110, 26);
  spawnCover(G, cx + 40, cy + 90, 110, 26);
  return G.cover;
}

export function spawnHealthPickup(G, x, y, amount) {
  ensureCombatState(G);
  G.pickups.push({ kind: 'health', x, y, amount: amount || 30 });
  return G.pickups[G.pickups.length - 1];
}

export function spawnAmmoPickup(G, x, y, amount) {
  ensureCombatState(G);
  G.pickups.push({ kind: 'ammo', x, y, amount: amount || 24 });
  return G.pickups[G.pickups.length - 1];
}

export function spawnMoneyPickup(G, x, y, amount) {
  ensureCombatState(G);
  G.pickups.push({ kind: 'money', x, y, amount: amount || 100 });
  return G.pickups[G.pickups.length - 1];
}

export function damagePlayer(G, amount) {
  if (!G.player) return;
  const factor = G.player.armorFactor || 1;
  G.player.health = Math.max(0, (G.player.health ?? 100) - amount * factor);
  if (G.player.health <= 0 && typeof G.onPlayerDown === 'function') {
    G.onPlayerDown();
  } else if (G.player.health <= 0) {
    G.state = 'gameover';
    G.caughtReason = 'DOWN';
  }
}

function blockedAt(G, x, y) {
  if (G.world && typeof G.world.isBlockedAt === 'function') return G.world.isBlockedAt(x, y);
  return false;
}

function pointInCover(G, x, y) {
  for (const c of G.cover) {
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return true;
  }
  return false;
}

function spawnParticles(G, x, y, kind) {
  if (!G.particles) return;
  for (let i = 0; i < 6; i++) {
    G.particles.push({ kind: kind || 'hit', x, y, life: 0.35, maxLife: 0.35,
      vx: ((G.rng ? G.rng() : Math.random()) - 0.5) * 160,
      vy: ((G.rng ? G.rng() : Math.random()) - 0.5) * 160 });
  }
}

// One bullet step: move, then test walls, cover, enemies, player, heli.
function stepBullet(G, b, dt) {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.life -= dt;
  if (b.life <= 0) return false;
  if (blockedAt(G, b.x, b.y) || pointInCover(G, b.x, b.y)) {
    spawnParticles(G, b.x, b.y, 'spark');
    return false;
  }
  if (b.from === 'player') {
    for (const e of G.enemies) {
      if (e.dead) continue;
      if (Math.hypot(e.x - b.x, e.y - b.y) < 16) {
        e.hp -= b.dmg;
        spawnParticles(G, b.x, b.y, 'hit');
        if (e.hp <= 0) {
          e.dead = true;
          if (G.rng ? G.rng() < 0.4 : Math.random() < 0.4) {
            spawnAmmoPickup(G, e.x, e.y, 24);
          } else if (G.rng ? G.rng() < 0.5 : Math.random() < 0.5) {
            spawnHealthPickup(G, e.x, e.y, 30);
          }
        }
        return false;
      }
    }
    // Player bullets can damage the helicopter (see helicopter.js).
    const h = G.helicopter;
    if (h && h.active && h.state !== 'off') {
      if (Math.hypot(h.x - b.x, h.y - b.y) < 42) {
        if (typeof G.takeHelicopterDamage === 'function') G.takeHelicopterDamage(b.dmg);
        else h.damage = (h.damage || 0) + b.dmg;
        spawnParticles(G, b.x, b.y, 'spark');
        return false;
      }
    }
    // Player bullets vs foot cops: cops take damage and the heat rises.
    if (G.police) {
      for (const cop of G.police.footCops) {
        if (Math.hypot(cop.x - b.x, cop.y - b.y) < 14) {
          cop.hp = (cop.hp ?? 50) - b.dmg;
          if (cop.hp <= 0) {
            cop.dead = true;
            if (G.addHeat) G.addHeat(12);
          }
          spawnParticles(G, b.x, b.y, 'hit');
          return false;
        }
      }
    }
  } else {
    const p = G.player;
    if (p && Math.hypot(p.x - b.x, p.y - b.y) < 14) {
      damagePlayer(G, b.dmg);
      spawnParticles(G, b.x, b.y, 'hit');
      return false;
    }
    // Enemy bullets cannot hurt the player's car occupants beyond the car.
    if (p && p.car && Math.hypot(p.car.x - b.x, p.car.y - b.y) < 22) {
      p.car.health = Math.max(0, (p.car.health ?? 100) - b.dmg * 0.5);
      spawnParticles(G, b.x, b.y, 'spark');
      return false;
    }
  }
  return true;
}

function moveEnemy(G, e, tx, ty, speed, dt) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 6) return;
  const nx = e.x + (dx / d) * speed * dt;
  const ny = e.y + (dy / d) * speed * dt;
  if (!blockedAt(G, nx, ny)) { e.x = nx; e.y = ny; }
  else if (!blockedAt(G, nx, e.y)) { e.x = nx; }
  else if (!blockedAt(G, e.x, ny)) { e.y = ny; }
  e.angle = Math.atan2(dy, dx);
}

// Enemy AI: pistol only. Walk to within ~240 of Rook, then hold and fire
// aimed shots on a slow timer with spread, so shootouts stay survivable.
function updateEnemy(G, e, dt) {
  const p = G.player;
  if (!p || e.dead) return;
  const dist = Math.hypot(p.x - e.x, p.y - e.y);
  if (dist > ENEMY_MOVE_RANGE) {
    moveEnemy(G, e, p.x, p.y, e.speed, dt);
    e.state = 'advancing';
  } else {
    e.state = 'shooting';
    e.angle = Math.atan2(p.y - e.y, p.x - e.x);
  }
  e.shootTimer -= dt;
  if (e.shootTimer <= 0 && dist < ENEMY_SHOOT_RANGE && p.onFoot) {
    e.shootTimer = ENEMY_SHOOT_INTERVAL + (G.rng ? G.rng() : Math.random()) * 0.4;
    const def = WEAPON_DEFS.pistol;
    const spread = ((G.rng ? G.rng() : Math.random()) - 0.5) * 0.16;
    const a = Math.atan2(p.y - e.y, p.x - e.x) + spread;
    G.bullets.push({
      x: e.x + Math.cos(a) * 24, y: e.y + Math.sin(a) * 24,
      vx: Math.cos(a) * def.bulletSpeed, vy: Math.sin(a) * def.bulletSpeed,
      dmg: ENEMY_PISTOL_DAMAGE, from: 'enemy', life: def.range / def.bulletSpeed,
    });
    if (G.audio) G.audio.play && G.audio.play('enemyShot');
  }
}

export function updateCombat(G, dt) {
  ensureCombatState(G);
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    if (!stepBullet(G, G.bullets[i], dt)) G.bullets.splice(i, 1);
  }
  for (const e of G.enemies) updateEnemy(G, e, dt);
  G.enemies = G.enemies.filter((e) => !e.dead);
  if (G.police) {
    G.police.footCops = G.police.footCops.filter((c) => !c.dead);
  }
  updatePickups(G, dt);
}

export function updatePickups(G, dt) {
  ensureCombatState(G);
  const p = G.player;
  if (!p) return;
  for (let i = G.pickups.length - 1; i >= 0; i--) {
    const pk = G.pickups[i];
    if (Math.hypot(pk.x - p.x, pk.y - p.y) < 36) {
      if (pk.kind === 'health') {
        p.health = Math.min(p.maxHealth || 100, (p.health ?? 100) + pk.amount);
      } else if (pk.kind === 'ammo') {
        if (G.weapons && G.weapons.current) {
          G.weapons.ammo[G.weapons.current] =
            (G.weapons.ammo[G.weapons.current] || 0) + pk.amount;
        }
      } else if (pk.kind === 'money') {
        p.cash = (p.cash || 0) + pk.amount;
      }
      if (G.audio) G.audio.play && G.audio.play('pickup');
      G.pickups.splice(i, 1);
    }
  }
}

export function clearCombat(G) {
  ensureCombatState(G);
  G.bullets = [];
  G.enemies = [];
  G.pickups = [];
  G.cover = [];
}

export function drawCombat(ctx, G, cam) {
  ensureCombatState(G);
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  for (const c of G.cover) {
    ctx.fillStyle = '#7a6a4f';
    ctx.fillRect(c.x - px, c.y - py, c.w, c.h);
    ctx.strokeStyle = '#4a3f2c';
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x - px, c.y - py, c.w, c.h);
  }
  for (const pk of G.pickups) {
    const x = pk.x - px;
    const y = pk.y - py;
    const bob = Math.sin((G.time ? G.time.t : 0) * 4 + pk.x) * 2;
    if (pk.kind === 'health') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 11, y - 11 + bob, 22, 22);
      ctx.fillStyle = '#e33';
      ctx.fillRect(x - 3, y - 8 + bob, 6, 16);
      ctx.fillRect(x - 8, y - 3 + bob, 16, 6);
    } else if (pk.kind === 'ammo') {
      ctx.fillStyle = '#2b2b2b';
      ctx.fillRect(x - 11, y - 7 + bob, 22, 14);
      ctx.fillStyle = '#ffd76a';
      ctx.fillRect(x - 8, y - 4 + bob, 4, 8);
      ctx.fillRect(x - 1, y - 4 + bob, 4, 8);
      ctx.fillRect(x + 6, y - 4 + bob, 4, 8);
    } else {
      ctx.fillStyle = '#2fae4e';
      ctx.beginPath();
      ctx.arc(x, y + bob, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', x, y + bob);
    }
  }
  for (const e of G.enemies) {
    const x = e.x - px;
    const y = e.y - py;
    ctx.fillStyle = '#7a1f1f';
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(e.angle) * 20, y + Math.sin(e.angle) * 20);
    ctx.stroke();
    // Health bar above the enemy.
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 14, y - 24, 28, 5);
    ctx.fillStyle = '#e33';
    ctx.fillRect(x - 14, y - 24, 28 * Math.max(0, e.hp / e.maxHp), 5);
  }
  for (const b of G.bullets) {
    const x = b.x - px;
    const y = b.y - py;
    ctx.strokeStyle = b.from === 'player' ? '#fff3a0' : '#ff9a5a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - b.vx * 0.02, y - b.vy * 0.02);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
}
