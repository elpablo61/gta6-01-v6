// save.js — 3 save slots for Crescent Bay (spec §3.5). Versioned
// localStorage keys, one per slot. The title screen lists 3 slots
// (mission progress, cash, date — or "Empty"); Continue loads a chosen
// slot; autosave after each mission writes to the active slot; manual
// save from the pause menu writes to the active slot. A corrupt slot
// shows as corrupt and can be overwritten — it never crashes the
// title screen. A save that already exists keeps its slot as the
// default active slot.

export const SAVE_VERSION = 1;
export const SAVE_SLOT_COUNT = 3;
export const SAVE_KEY_PREFIX = 'crescent-bay-save-v1-slot-';

export function saveKey(slot) {
  return `${SAVE_KEY_PREFIX}${slot}`;
}

function hasStorage() {
  return typeof localStorage !== 'undefined' && localStorage !== null;
}

// Serialize the game state into a plain save object. Only plain data:
// mission progress, cash, position, health, weapons, clock, date.
export function serializeGame(G) {
  const mission = G.mission || {};
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    mission: {
      completed: Array.isArray(mission.completed) ? mission.completed.slice() : [],
      highest: typeof mission.highest === 'number' ? mission.highest : 0,
    },
    player: {
      x: G.player ? G.player.x : 600,
      y: G.player ? G.player.y : 800,
      health: G.player ? G.player.health : 100,
      cash: G.player ? G.player.cash : 0,
    },
    weapons: G.weapons ? {
      owned: { ...(G.weapons.owned || { pistol: true }) },
      current: G.weapons.current || 'pistol',
      ammo: { ...(G.weapons.ammo || { pistol: 48 }) },
    } : null,
    time: G.time ? { hour: G.time.hour || 8 } : { hour: 8 },
  };
}

// Apply a loaded save object onto the live game state.
export function applySave(G, data) {
  if (!data || typeof data !== 'object') return false;
  if (G.mission) {
    G.mission.completed = Array.isArray(data.mission && data.mission.completed)
      ? data.mission.completed.slice()
      : [];
    G.mission.highest = (data.mission && data.mission.highest) || 0;
    G.mission.id = null;
    G.mission.stage = 0;
    G.mission.state = 'none';
    G.mission.dialogOpen = false;
    G.mission.timeLeft = 0;
    G.mission.data = {};
    G.mission.marker = null;
  }
  if (G.player && data.player) {
    G.player.x = data.player.x;
    G.player.y = data.player.y;
    G.player.health = data.player.health;
    G.player.cash = data.player.cash;
    G.player.onFoot = true;
    G.player.car = null;
    G.player.speed = 0;
  }
  if (G.weapons && data.weapons) {
    G.weapons.owned = { ...data.weapons.owned };
    G.weapons.current = data.weapons.current || 'pistol';
    G.weapons.ammo = { ...data.weapons.ammo };
  }
  if (G.time && data.time) {
    G.time.hour = data.time.hour || 8;
    G.time.night = G.time.hour < 5.5 || G.time.hour > 19.5 ? 1 : 0;
  }
  if (G.police) {
    G.police.footCops = [];
    G.police.patrolCars = [];
    G.police.roadblocks = [];
  }
  G.heat = 0;
  G.stars = 0;
  return true;
}

// Write the game into a slot. Returns { ok: true, slot } or
// { ok: false, error } — never throws.
export function saveGame(G, slot) {
  const s = typeof slot === 'number' ? slot : (typeof G.activeSlot === 'number' ? G.activeSlot : 0);
  if (s < 0 || s >= SAVE_SLOT_COUNT) return { ok: false, error: 'bad slot' };
  if (!hasStorage()) return { ok: false, error: 'no storage' };
  try {
    const data = serializeGame(G);
    localStorage.setItem(saveKey(s), JSON.stringify(data));
    G.activeSlot = s;
    return { ok: true, slot: s, savedAt: data.savedAt };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Autosave after a mission completes: writes to the active slot.
export function autosave(G) {
  return saveGame(G, typeof G.activeSlot === 'number' ? G.activeSlot : 0);
}

// Read one slot without throwing. Returns:
// { slot, empty: true } | { slot, data } | { slot, corrupt: true }.
export function readSaveSlot(slot) {
  if (!hasStorage()) return { slot, empty: true };
  let raw = null;
  try {
    raw = localStorage.getItem(saveKey(slot));
  } catch (err) {
    return { slot, empty: true };
  }
  if (raw === null || raw === undefined || raw === '') return { slot, empty: true };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || data.version !== SAVE_VERSION) {
      return { slot, corrupt: true };
    }
    return { slot, data };
  } catch (err) {
    return { slot, corrupt: true };
  }
}

// Load a slot into the game. Returns { ok: true, slot } on success,
// { ok: false, empty: true } when the slot is empty, or
// { ok: false, corrupt: true } when the slot is unreadable.
export function loadGame(G, slot) {
  const s = typeof slot === 'number' ? slot : 0;
  const read = readSaveSlot(s);
  if (read.empty) return { ok: false, empty: true, slot: s };
  if (read.corrupt) return { ok: false, corrupt: true, slot: s };
  const applied = applySave(G, read.data);
  if (!applied) return { ok: false, corrupt: true, slot: s };
  G.activeSlot = s;
  return { ok: true, slot: s };
}

// List all 3 slots for the title screen: each entry carries a short
// summary (mission progress, cash, date) or 'Empty' / 'Corrupt'.
export function listSaveSlots() {
  const slots = [];
  for (let s = 0; s < SAVE_SLOT_COUNT; s++) {
    const read = readSaveSlot(s);
    if (read.empty) {
      slots.push({ slot: s, empty: true, label: 'Empty' });
    } else if (read.corrupt) {
      slots.push({ slot: s, corrupt: true, label: 'Corrupt — can be overwritten' });
    } else {
      const d = read.data;
      const missions = (d.mission && d.mission.completed ? d.mission.completed.length : 0);
      const cash = d.player ? d.player.cash : 0;
      const date = d.savedAt ? d.savedAt.slice(0, 10) : '';
      slots.push({
        slot: s,
        data: d,
        label: `Missions ${missions}/12 · $${cash} · ${date}`,
        missions,
        cash,
        date,
      });
    }
  }
  return slots;
}

// Delete a slot (overwrite path for corrupt slots uses saveGame).
export function deleteSave(slot) {
  if (!hasStorage()) return false;
  try {
    localStorage.removeItem(saveKey(slot));
    return true;
  } catch (err) {
    return false;
  }
}

// Default active slot: keep the single-slot behaviour — if a save
// already exists, its slot stays the default active slot.
export function defaultActiveSlot() {
  for (let s = 0; s < SAVE_SLOT_COUNT; s++) {
    const read = readSaveSlot(s);
    if (!read.empty && !read.corrupt) return s;
  }
  return 0;
}
