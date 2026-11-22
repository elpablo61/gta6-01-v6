// weapons.js — pistol, SMG, shotgun. Per-weapon ammo, instant switching,
// weapon crates in the world and in shootout arenas.
export const WEAPON_DEFS = {
  pistol: {
    id: 'pistol', name: 'Pistol', key: '1', damage: 18, pellets: 1,
    fireInterval: 0.28, bulletSpeed: 900, spread: 0.02, range: 520,
    startAmmo: 48, crateAmmo: 48, pickupAmmo: 24,
  },
  smg: {
    id: 'smg', name: 'SMG', key: '2', damage: 10, pellets: 1,
    fireInterval: 0.08, bulletSpeed: 950, spread: 0.07, range: 420,
    startAmmo: 0, crateAmmo: 120, pickupAmmo: 48,
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', key: '3', damage: 8, pellets: 5,
    fireInterval: 0.9, bulletSpeed: 750, spread: 0.22, range: 220,
    startAmmo: 0, crateAmmo: 32, pickupAmmo: 16,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun'];

export function createWeaponsState() {
  return {
    owned: { pistol: true, smg: false, shotgun: false },
    current: 'pistol',
    ammo: { pistol: WEAPON_DEFS.pistol.startAmmo, smg: 0, shotgun: 0 },
    cooldown: 0,
  };
}

export function ensureWeaponsState(G) {
  if (!G.weapons) G.weapons = createWeaponsState();
  if (!G.weapons.owned) G.weapons.owned = { pistol: true, smg: false, shotgun: false };
  if (!G.weapons.ammo) {
    G.weapons.ammo = { pistol: WEAPON_DEFS.pistol.startAmmo, smg: 0, shotgun: 0 };
  }
  if (!G.weapons.current || !WEAPON_DEFS[G.weapons.current]) G.weapons.current = 'pistol';
  if (typeof G.weapons.cooldown !== 'number') G.weapons.cooldown = 0;
  if (!Array.isArray(G.bullets)) G.bullets = [];
  if (!Array.isArray(G.crates)) G.crates = [];
  return G.weapons;
}

export function currentWeaponDef(G) {
  ensureWeaponsState(G);
  return WEAPON_DEFS[G.weapons.current];
}

export function currentAmmo(G) {
  ensureWeaponsState(G);
  return G.weapons.ammo[G.weapons.current] || 0;
}

// Switching is instant: no animation lock, works on foot and in a car.
export function selectWeapon(G, id) {
  ensureWeaponsState(G);
  if (!WEAPON_DEFS[id]) return false;
  if (!G.weapons.owned[id]) return false;
  if (G.weapons.current === id) return true;
  G.weapons.current = id;
  G.weapons.cooldown = 0;
  if (G.audio) G.audio.play && G.audio.play('weaponSwitch');
  return true;
}

export function cycleWeapon(G) {
  ensureWeaponsState(G);
  const owned = WEAPON_ORDER.filter((id) => G.weapons.owned[id]);
  if (owned.length < 2) return false;
  const idx = owned.indexOf(G.weapons.current);
  const next = owned[(idx + 1) % owned.length];
  return selectWeapon(G, next);
}

export function giveWeapon(G, id, ammoBonus) {
  ensureWeaponsState(G);
  if (!WEAPON_DEFS[id]) return false;
  const had = G.weapons.owned[id];
  G.weapons.owned[id] = true;
  const bonus = typeof ammoBonus === 'number' ? ammoBonus : WEAPON_DEFS[id].crateAmmo;
  G.weapons.ammo[id] = (G.weapons.ammo[id] || 0) + bonus;
  if (!had) G.weapons.current = id;
  if (G.audio) G.audio.play && G.audio.play('pickup');
  return true;
}

export function addAmmo(G, id, amount) {
  ensureWeaponsState(G);
  if (!WEAPON_DEFS[id]) return false;
  G.weapons.ammo[id] = (G.weapons.ammo[id] || 0) + amount;
  return true;
}

export function canFire(G) {
  ensureWeaponsState(G);
  const def = WEAPON_DEFS[G.weapons.current];
  if (G.weapons.cooldown > 0) return false;
  if ((G.weapons.ammo[G.weapons.current] || 0) <= 0) return false;
  if (!G.player || !G.player.onFoot) return false;
  return !!def;
}

// Fire from the player's position along aimAngle. One shell = one ammo
// for every weapon; the shotgun spends one shell for 5 pellets.
export function fireWeapon(G) {
  ensureWeaponsState(G);
  if (!canFire(G)) return false;
  const def = WEAPON_DEFS[G.weapons.current];
  const p = G.player;
  G.weapons.ammo[G.weapons.current] -= 1;
  G.weapons.cooldown = def.fireInterval;
  const rng = G.rng || Math.random;
  for (let i = 0; i < def.pellets; i++) {
    const spread = (rng() - 0.5) * 2 * def.spread;
    const a = (p.aimAngle ?? p.angle ?? 0) + spread;
    const muzzle = 26;
    G.bullets.push({
      x: p.x + Math.cos(a) * muzzle,
      y: p.y + Math.sin(a) * muzzle,
      vx: Math.cos(a) * def.bulletSpeed,
      vy: Math.sin(a) * def.bulletSpeed,
      dmg: def.damage,
      from: 'player',
      life: def.range / def.bulletSpeed,
    });
  }
  if (G.particles) {
    G.particles.push({ kind: 'muzzle', x: p.x + Math.cos(p.aimAngle ?? 0) * 28,
      y: p.y + Math.sin(p.aimAngle ?? 0) * 28, life: 0.08, maxLife: 0.08 });
  }
  if (G.audio) G.audio.play && G.audio.play('gunshot');
  return true;
}

export function tickWeaponCooldown(G, dt) {
  ensureWeaponsState(G);
  if (G.weapons.cooldown > 0) G.weapons.cooldown -= dt;
}

// Weapon crates: SMG + shotgun at fixed spots (gun store, docks, hideout)
// plus crates inside the m10/m12 shootout arenas. Walking over a crate
// picks the weapon up and gives ammo.
export function spawnWeaponCrate(G, kind, x, y) {
  ensureWeaponsState(G);
  G.crates.push({ kind, x, y, taken: false });
  return G.crates[G.crates.length - 1];
}

export function spawnWorldCrates(G) {
  ensureWeaponsState(G);
  const w = G.world || {};
  if (w.gunStore) spawnWeaponCrate(G, 'smg', w.gunStore.x, w.gunStore.y);
  if (w.docks) spawnWeaponCrate(G, 'shotgun', w.docks.x, w.docks.y);
  if (w.hideout) spawnWeaponCrate(G, 'smg', w.hideout.x + 60, w.hideout.y);
}

export function spawnArenaCrates(G, cx, cy) {
  ensureWeaponsState(G);
  spawnWeaponCrate(G, 'smg', cx - 90, cy - 60);
  spawnWeaponCrate(G, 'shotgun', cx + 90, cy + 60);
  return G.crates;
}

export function updateWeaponCrates(G, dt) {
  ensureWeaponsState(G);
  const p = G.player;
  if (!p) return;
  for (const crate of G.crates) {
    if (crate.taken) continue;
    if (Math.hypot(crate.x - p.x, crate.y - p.y) < 42) {
      crate.taken = true;
      if (crate.kind === 'ammo') {
        addAmmo(G, G.weapons.current, WEAPON_DEFS[G.weapons.current].pickupAmmo);
      } else {
        giveWeapon(G, crate.kind);
      }
      if (G.hudMessage) G.hudMessage = `Picked up ${WEAPON_DEFS[crate.kind] ? WEAPON_DEFS[crate.kind].name : 'Ammo'}`;
    }
  }
  G.crates = G.crates.filter((c) => !c.taken);
}

export function drawWeaponCrates(ctx, G, cam) {
  ensureWeaponsState(G);
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  for (const crate of G.crates) {
    const x = crate.x - px;
    const y = crate.y - py;
    const bob = Math.sin((G.time ? G.time.t : 0) * 3 + crate.x) * 2;
    ctx.fillStyle = '#5a3d1e';
    ctx.fillRect(x - 14, y - 10 + bob, 28, 20);
    ctx.strokeStyle = '#d8b25a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 14, y - 10 + bob, 28, 20);
    ctx.fillStyle = '#ffd76a';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = crate.kind === 'smg' ? 'SMG' : crate.kind === 'shotgun' ? 'SG' : 'AMMO';
    ctx.fillText(label, x, y + bob);
  }
}
