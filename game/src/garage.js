// garage.js — Fixer Garage upgrades at the mission-giver location.
// Drive into the garage zone and press E to open the upgrade menu (a DOM
// overlay that pauses the world). Upgrades apply to the player's CURRENT
// car and stay on that car (stored per car in car.upgrades). Paint is
// visual only; the Spray Shop is a different place and still only clears
// heat. Esc closes the menu first — the world stays paused until the menu
// is closed. m11 requires a purchase: missions.js watches the purchase
// counter exported here.
export const GARAGE_UPGRADES = {
  engine: {
    id: 'engine', name: 'Engine', max: 3, prices: [800, 1500, 2500],
    desc: '+55 top speed per level',
  },
  armor: {
    id: 'armor', name: 'Armor', max: 3, prices: [500, 900, 1400],
    desc: '15% damage resistance per level',
  },
  tires: {
    id: 'tires', name: 'Tires', max: 2, prices: [400, 800],
    desc: 'Better handling and turning per level',
  },
  brakes: {
    id: 'brakes', name: 'Brakes', max: 2, prices: [350, 700],
    desc: 'Shorter stopping distance per level',
  },
};

export const GARAGE_UPGRADE_ORDER = ['engine', 'armor', 'tires', 'brakes'];

export const GARAGE_PAINTS = [
  { id: 'red', name: 'Crimson', color: '#e33b3b' },
  { id: 'blue', name: 'Harbor Blue', color: '#2a6bff' },
  { id: 'yellow', name: 'Taxi Gold', color: '#ffd23a' },
  { id: 'green', name: 'Palm Green', color: '#2ecc71' },
  { id: 'purple', name: 'Neon Violet', color: '#9b59b6' },
  { id: 'white', name: 'Pearl White', color: '#f2f2f2' },
];

export const GARAGE_PAINT_PRICE = 150;
export const GARAGE_ENGINE_SPEED_PER_LEVEL = 55;
export const GARAGE_ARMOR_RESIST_PER_LEVEL = 0.15;

export function createGarageState() {
  return {
    open: false, menuEl: null, zone: null,
    purchases: 0, lastPurchase: null,
    prevEsc: false, prevInteract: false,
  };
}

export function ensureGarageState(G) {
  if (!G.garage) G.garage = createGarageState();
  if (typeof G.garage.purchases !== 'number') G.garage.purchases = 0;
  if (typeof G.garage.open !== 'boolean') G.garage.open = false;
  return G.garage;
}

export function garageZone(G) {
  ensureGarageState(G);
  if (G.garage.zone) return G.garage.zone;
  const w = G.world || {};
  if (w.garage && typeof w.garage.x === 'number') {
    G.garage.zone = { x: w.garage.x, y: w.garage.y, r: w.garage.r || 110 };
  } else {
    // Fallback: a road junction (roads at 200 + i*400).
    G.garage.zone = { x: 1000, y: 600, r: 110 };
  }
  return G.garage.zone;
}

function playerPos(G) {
  const p = G.player;
  if (!p) return null;
  if (p.car) return { x: p.car.x, y: p.car.y };
  return { x: p.x, y: p.y };
}

export function isInGarageZone(G) {
  const pos = playerPos(G);
  if (!pos) return false;
  const z = garageZone(G);
  return Math.hypot(pos.x - z.x, pos.y - z.y) < z.r;
}

function ensureCarUpgrades(car) {
  if (!car.upgrades) car.upgrades = { engine: 0, armor: 0, tires: 0, brakes: 0 };
  for (const k of GARAGE_UPGRADE_ORDER) {
    if (typeof car.upgrades[k] !== 'number') car.upgrades[k] = 0;
  }
  return car.upgrades;
}

// Recompute a car's live stats from its stored upgrade levels. The base
// top speed is remembered the first time an upgrade is applied so buying
// never stacks on an already-boosted value.
export function applyUpgradesToCar(car) {
  if (!car) return car;
  const up = ensureCarUpgrades(car);
  if (typeof car.baseTopSpeed !== 'number') car.baseTopSpeed = car.topSpeed || 400;
  car.topSpeed = car.baseTopSpeed + up.engine * GARAGE_ENGINE_SPEED_PER_LEVEL;
  car.damageResistance = up.armor * GARAGE_ARMOR_RESIST_PER_LEVEL;
  car.handling = 1 + up.tires * 0.15;
  car.brakePower = 1 + up.brakes * 0.25;
  return car;
}

export function effectiveTopSpeed(car) {
  if (!car) return 0;
  const base = typeof car.baseTopSpeed === 'number' ? car.baseTopSpeed : (car.topSpeed || 0);
  const engine = car.upgrades ? (car.upgrades.engine || 0) : 0;
  return base + engine * GARAGE_ENGINE_SPEED_PER_LEVEL;
}

export function damageMultiplierForCar(car) {
  if (!car) return 1;
  const armor = car.upgrades ? (car.upgrades.armor || 0) : 0;
  return Math.max(0.1, 1 - armor * GARAGE_ARMOR_RESIST_PER_LEVEL);
}

export function nextUpgradePrice(G, kind) {
  const car = G.player && G.player.car;
  if (!car) return null;
  const def = GARAGE_UPGRADES[kind];
  if (!def) return null;
  const up = ensureCarUpgrades(car);
  if (up[kind] >= def.max) return null;
  return def.prices[up[kind]];
}

export function cheapestAvailableUpgrade(G) {
  let best = null;
  let bestPrice = Infinity;
  for (const kind of GARAGE_UPGRADE_ORDER) {
    const price = nextUpgradePrice(G, kind);
    if (price !== null && price < bestPrice) {
      best = kind;
      bestPrice = price;
    }
  }
  return best ? { kind: best, price: bestPrice } : null;
}

export function garagePurchaseCount(G) {
  ensureGarageState(G);
  return G.garage.purchases;
}

export function buyUpgrade(G, kind) {
  ensureGarageState(G);
  const p = G.player;
  if (!p || !p.car) return false;
  const def = GARAGE_UPGRADES[kind];
  if (!def) return false;
  const car = p.car;
  const up = ensureCarUpgrades(car);
  if (up[kind] >= def.max) return false;
  const price = def.prices[up[kind]];
  if ((p.cash || 0) < price) return false;
  p.cash -= price;
  up[kind] += 1;
  applyUpgradesToCar(car);
  G.garage.purchases += 1;
  G.garage.lastPurchase = { kind, level: up[kind], price, at: G.time ? G.time.t : 0 };
  // Track the purchase on the active mission too (m11 completes only
  // after a purchase AND its checkpoints).
  if (G.mission && G.mission.state === 'active') G.mission.data.boughtUpgrade = true;
  if (G.audio) G.audio.play && G.audio.play('purchase');
  refreshGarageMenu(G);
  return true;
}

export function buyPaint(G, paintId) {
  ensureGarageState(G);
  const p = G.player;
  if (!p || !p.car) return false;
  const paint = GARAGE_PAINTS.find((c) => c.id === paintId);
  if (!paint) return false;
  if ((p.cash || 0) < GARAGE_PAINT_PRICE) return false;
  if (p.car.paint === paintId) return false;
  p.cash -= GARAGE_PAINT_PRICE;
  p.car.paint = paintId;
  p.car.color = paint.color;
  G.garage.purchases += 1;
  G.garage.lastPurchase = { kind: 'paint', level: 0, price: GARAGE_PAINT_PRICE, at: G.time ? G.time.t : 0 };
  if (G.mission && G.mission.state === 'active') G.mission.data.boughtUpgrade = true;
  if (G.audio) G.audio.play && G.audio.play('purchase');
  refreshGarageMenu(G);
  return true;
}

function hasDocument() {
  return typeof document !== 'undefined' && document && typeof document.createElement === 'function';
}

function upgradeRowHtml(G, kind) {
  const def = GARAGE_UPGRADES[kind];
  const car = G.player && G.player.car;
  const up = car ? ensureCarUpgrades(car) : { [kind]: 0 };
  const level = up[kind] || 0;
  const maxed = level >= def.max;
  const price = maxed ? null : def.prices[level];
  const afford = price !== null && (G.player.cash || 0) >= price;
  let pips = '';
  for (let i = 0; i < def.max; i++) pips += i < level ? '●' : '○';
  return `<div class="garage-row" style="display:flex;align-items:center;gap:10px;margin:6px 0;">
    <span style="width:70px;font-weight:bold;">${def.name}</span>
    <span style="color:#ffd76a;letter-spacing:2px;">${pips}</span>
    <span style="flex:1;color:#bbb;font-size:13px;">${def.desc}</span>
    <button data-upgrade="${kind}" ${maxed || !afford ? 'disabled' : ''}
      style="padding:6px 12px;cursor:pointer;">${maxed ? 'MAX' : '$' + price}</button>
  </div>`;
}

export function refreshGarageMenu(G) {
  ensureGarageState(G);
  if (!hasDocument() || !G.garage.menuEl) return;
  const car = G.player && G.player.car;
  const carName = car ? (car.type || 'car') : 'no car';
  const cash = (G.player && G.player.cash) || 0;
  const paints = GARAGE_PAINTS.map((c) => {
    const active = car && car.paint === c.id;
    return `<button data-paint="${c.id}" title="${c.name}" ${active ? 'disabled' : ''}
      style="width:34px;height:34px;border-radius:50%;border:${active ? '3px solid #fff' : '2px solid #555'};
      background:${c.color};cursor:pointer;margin:2px;"></button>`;
  }).join('');
  G.garage.menuEl.innerHTML = `
    <div style="font-size:22px;font-weight:bold;margin-bottom:2px;">FIXER GARAGE</div>
    <div style="color:#bbb;margin-bottom:8px;">${carName} &nbsp;·&nbsp; Cash: $${cash}</div>
    ${GARAGE_UPGRADE_ORDER.map((k) => upgradeRowHtml(G, k)).join('')}
    <div style="margin-top:10px;">Paint — $${GARAGE_PAINT_PRICE} <span style="color:#bbb;font-size:13px;">(visual only)</span></div>
    <div>${paints}</div>
    <div style="margin-top:12px;color:#bbb;font-size:13px;">Upgrades stay on this car. Esc closes the garage.</div>
    <button data-close="1" style="margin-top:10px;padding:8px 18px;cursor:pointer;">Close (Esc)</button>`;
  const menu = G.garage.menuEl;
  menu.querySelectorAll('[data-upgrade]').forEach((btn) => {
    btn.addEventListener('click', () => buyUpgrade(G, btn.getAttribute('data-upgrade')));
  });
  menu.querySelectorAll('[data-paint]').forEach((btn) => {
    btn.addEventListener('click', () => buyPaint(G, btn.getAttribute('data-paint')));
  });
  const closeBtn = menu.querySelector('[data-close]');
  if (closeBtn) closeBtn.addEventListener('click', () => closeGarage(G));
}

export function openGarage(G) {
  ensureGarageState(G);
  if (G.garage.open) return true;
  if (!G.player || !G.player.car) return false;
  G.garage.open = true;
  // The world pauses while the menu is open; main.js skips world
  // updates while G.paused is true.
  G.paused = true;
  if (hasDocument()) {
    const el = document.createElement('div');
    el.id = 'garage-menu';
    el.setAttribute('role', 'dialog');
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'background:rgba(16,18,28,0.96);color:#f2f2f2;border:2px solid #ffd76a;border-radius:10px;'
      + 'padding:18px 22px;z-index:40;min-width:420px;font-family:sans-serif;';
    document.body.appendChild(el);
    G.garage.menuEl = el;
    refreshGarageMenu(G);
  }
  if (G.audio) G.audio.play && G.audio.play('menuOpen');
  return true;
}

export function closeGarage(G) {
  ensureGarageState(G);
  if (!G.garage.open) return false;
  G.garage.open = false;
  G.paused = false;
  if (G.garage.menuEl && G.garage.menuEl.remove) G.garage.menuEl.remove();
  G.garage.menuEl = null;
  if (G.audio) G.audio.play && G.audio.play('menuClose');
  return true;
}

function keyDown(G, codes) {
  if (!G.input || !G.input.keys) return false;
  for (const c of codes) if (G.input.keys.has(c)) return true;
  return false;
}

function interactEdge(G) {
  const down = keyDown(G, ['KeyE', 'e', 'E']) || !!(G.input && G.input.interactPressed);
  const edge = down && !G.garage.prevInteract;
  G.garage.prevInteract = down;
  return edge;
}

// Esc closes the garage menu FIRST (world stays paused until the menu is
// closed). Returns true when it consumed the key. main.js must call this
// before its own pause toggle.
export function garageEscapeConsumed(G) {
  ensureGarageState(G);
  const down = keyDown(G, ['Escape', 'Esc']);
  const edge = down && !G.garage.prevEsc;
  G.garage.prevEsc = down;
  if (edge && G.garage.open) {
    closeGarage(G);
    return true;
  }
  return false;
}

export function updateGarage(G, dt) {
  ensureGarageState(G);
  if (garageEscapeConsumed(G)) return;
  if (G.garage.open) {
    // While the menu is open the world is paused; keep the armor factor
    // of the current car in sync so damage taken right after closing
    // uses the upgraded resistance.
    if (G.player && G.player.car) {
      G.player.armorFactor = damageMultiplierForCar(G.player.car);
    }
    return;
  }
  if (G.state !== 'playing') return;
  if (G.mission && G.mission.dialogOpen) return;
  if (!G.player || !G.player.car) return;
  if (!isInGarageZone(G)) return;
  if (interactEdge(G)) openGarage(G);
}

export function drawGarageZone(ctx, G, cam) {
  ensureGarageState(G);
  if (G.garage.open) return;
  const z = garageZone(G);
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  const x = z.x - px;
  const y = z.y - py;
  ctx.strokeStyle = 'rgba(255, 215, 106, 0.8)';
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.arc(x, y, z.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffd76a';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FIXER GARAGE', x, y - z.r - 16);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#f2f2f2';
  ctx.fillText('Drive in + press E for upgrades', x, y);
}
