// main.js — game loop + wiring for Crescent Bay. Creates the shared
// state G EXACTLY per game/src/BUILDER-B-CONTRACT.md, auto-wires the
// Builder B systems with graceful fallback (the base game runs
// standalone now; garage / radio / missions plug in when they land),
// and runs the fixed-timestep loop.
//
// Critical ordering (spec §9.2): the autopilot runs BEFORE the dialog
// branch (otherwise it can never press E to accept a mission), and
// manual driving is skipped on frames the autopilot drove (otherwise
// the car can never build speed). The pause toggle is checked BEFORE
// the early exit, so pause can always be left again. Edge input flags
// are cleared at the END of the frame, after every system has read
// them — never before.

import {
  GAME_TITLE, WORLD_SEED, PLAYER_SPAWN, DAY_LENGTH_SECONDS,
} from './config.js';
import { createRng } from './random.js';
import {
  createInputState, createAutoInputState, attachInput, clearEdgeFlags,
} from './input.js';
import { createAudioEngine } from './audio.js';
import { createWorld } from './world.js';
import { createPlayerState, updatePlayer, drawPlayer } from './player.js';
import { spawnParkedCars } from './vehicles.js';
import { updateTraffic, drawCars } from './traffic.js';
import { updatePedestrians, drawPedestrians } from './pedestrians.js';
import { createStaticLayer, drawScene } from './render.js';
import {
  saveGame, loadGame, autosave, listSaveSlots, defaultActiveSlot,
} from './save.js';
import {
  ensurePoliceState, updateWantedHeat, updatePolice,
} from './police.js';
import {
  ensureWeaponsState, spawnWorldCrates, updateWeaponCrates,
} from './weapons.js';
import { ensureCombatState, updateCombat } from './combat.js';
import { ensureHelicopterState, updateHelicopter, takeHelicopterDamage } from './helicopter.js';

// Create the shared game state G. Every field is the one the Builder
// B contract names, with the exact shape its modules expect.
export function createGameState() {
  const rng = createRng(WORLD_SEED);
  const world = createWorld(rng);
  const G = {
    // Player (contract shape).
    player: createPlayerState(),
    // All cars: parked, traffic, patrol targets, courier, player car.
    cars: [],
    traffic: [],
    peds: [],
    world,
    heat: 0,
    stars: 0,
    wantedCover: false,
    time: { t: 0, night: 0, hour: 8 },
    input: createInputState(),
    autoInput: createAutoInputState(),
    autopilotActive: false,
    autopilotDrove: false,
    bullets: [],
    enemies: [],
    pickups: [],
    crates: [],
    cover: [],
    police: null,
    helicopter: null,
    weapons: null,
    radio: null,
    garage: null,
    mission: null,
    paused: false,
    state: 'title', // title | playing | paused | gameover
    camera: { x: 0, y: 0 },
    particles: [],
    audio: null,
    rng,
    shootoutActive: false,
    shootoutCenter: null,
    // Systems registry: Builder B modules land here (dynamic import
    // with graceful fallback — see wireSystems).
    systems: {},
    activeSlot: 0,
    selectedSlot: 0,
    hudMessage: '',
    hudMessageUntil: 0,
    lastGunshot: null,
    fps: 0,
    caughtReason: null,
    staticLayer: null,
    minimapLayer: null,
    // Hooks other systems call back into main through.
    onCaught: null,
    onPlayerDown: null,
    onMissionComplete: null,
    addHeat: null,
    takeHelicopterDamage: null,
    // Internal: the real keyboard/mouse state (G.input is swapped to
    // G.autoInput while the autopilot is active, then restored).
    _realInput: null,
    _frame: 0,
  };
  G._realInput = G.input;
  G.player.x = PLAYER_SPAWN.x;
  G.player.y = PLAYER_SPAWN.y;
  // Fill every subsystem's state object now, so no module ever sees
  // an undefined slice of G.
  ensurePoliceState(G);
  ensureWeaponsState(G);
  ensureCombatState(G);
  ensureHelicopterState(G);
  G.weapons.ammo.pistol = 48;
  // Bound helpers are attached by wireSystems (G.addHeat /
  // G.takeHelicopterDamage) once the police module is registered.
  return G;
}

// Auto-wire the Builder B systems. Modules that are not on disk yet
// (garage / radio / missions while B-2 writes them, autopilot / hud
// until batch B-3) fail soft: the base game keeps running and the
// module plugs in when it lands. Static systems (police, weapons,
// combat, helicopter) are registered from the static imports above.
export async function wireSystems(G) {
  const staticSystems = {
    police: await import('./police.js'),
    weapons: await import('./weapons.js'),
    combat: await import('./combat.js'),
    helicopter: await import('./helicopter.js'),
    traffic: await import('./traffic.js'),
    pedestrians: await import('./pedestrians.js'),
    player: await import('./player.js'),
  };
  Object.assign(G.systems, staticSystems);
  G.addHeat = (amount) => staticSystems.police.addHeat(G, amount);
  G.takeHelicopterDamage = (amount) => takeHelicopterDamage(G, amount);

  const optional = [
    ['garage', './garage.js'],
    ['radio', './radio.js'],
    ['missions', './missions.js'],
    ['autopilot', './autopilot.js'],
    ['hud', './hud.js'],
  ];
  for (const [name, path] of optional) {
    try {
      const mod = await import(path);
      G.systems[name] = mod;
      if (mod.ensureMissionState) mod.ensureMissionState(G);
      if (mod.ensureGarageState) mod.ensureGarageState(G);
      if (mod.ensureRadioState) mod.ensureRadioState(G);
      if (mod.ensureWeaponsState) mod.ensureWeaponsState(G);
    } catch (err) {
      // Graceful fallback: the base game runs standalone without it.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[crescent] optional system ${name} not loaded: ${err && err.message ? err.message : err}`);
      }
    }
  }
  return G.systems;
}

// --- day / night -----------------------------------------------------------

function updateClock(G, dt) {
  G.time.t += dt;
  const hour = (8 + (G.time.t / DAY_LENGTH_SECONDS) * 24) % 24;
  G.time.hour = hour;
  // Night is full at 20:00-05:00, day is full at 07:00-19:00, with a
  // one-hour dawn/dusk blend in between.
  let night = 0;
  if (hour >= 20 || hour < 5) night = 1;
  else if (hour >= 5 && hour < 6) night = 1 - (hour - 5);
  else if (hour >= 19 && hour < 20) night = hour - 19;
  else night = 0;
  G.time.night = night;
}

// --- camera ----------------------------------------------------------------

function updateCamera(G, canvas) {
  const p = G.player;
  if (!p || !canvas) return;
  const W = canvas.width;
  const H = canvas.height;
  let cx = p.x - W / 2;
  let cy = p.y - H / 2;
  cx = Math.max(0, Math.min(G.world.size - W, cx));
  cy = Math.max(0, Math.min(G.world.size - H, cy));
  // A viewport larger than the world just shows the whole world.
  if (G.world.size - W < 0) cx = (G.world.size - W) / 2;
  if (G.world.size - H < 0) cy = (G.world.size - H) / 2;
  G.camera.x = cx;
  G.camera.y = cy;
}

// --- particles -------------------------------------------------------------

function updateParticles(G, dt) {
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const pt = G.particles[i];
    pt.life -= dt;
    if (pt.life <= 0) {
      G.particles.splice(i, 1);
      continue;
    }
    if (pt.vx) pt.x += pt.vx * dt;
    if (pt.vy) pt.y += pt.vy * dt;
  }
  if (G.particles.length > 400) G.particles.splice(0, G.particles.length - 400);
}

// --- one fixed step --------------------------------------------------------

function stepGame(G, dt) {
  const sys = G.systems;
  updateClock(G, dt);

  // AUTOPILOT FIRST, before the dialog branch: the autopilot must be
  // able to press E to accept a mission (spec §9.2).
  G.autopilotDrove = false;
  if (sys.autopilot && typeof sys.autopilot.updateAutopilot === 'function') {
    sys.autopilot.updateAutopilot(G, dt);
  }
  // While the autopilot is active, every system reads its input.
  const realInput = G._realInput || G.input;
  if (G.autopilotActive && G.autoInput) G.input = G.autoInput;

  try {
    // Dialog branch: missions accept E here, before any car search.
    if (sys.missions && typeof sys.missions.updateMissions === 'function') {
      sys.missions.updateMissions(G, dt);
    }
    // Garage menu pauses the world while it is open.
    if (sys.garage && typeof sys.garage.updateGarage === 'function') {
      sys.garage.updateGarage(G, dt);
    }
    if (G.garage && G.garage.open) return;

    // THE PLAYER UPDATE: after every edit, verify this call still
    // runs — the arc progress log must show movement.
    updatePlayer(G, dt);

    updateTraffic(G, dt);
    updatePedestrians(G, dt);
    updateWantedHeat(G, dt);
    updatePolice(G, dt);
    updateHelicopter(G, dt);
    updateCombat(G, dt);
    updateWeaponCrates(G, dt);
    if (sys.radio && typeof sys.radio.updateRadio === 'function') {
      sys.radio.updateRadio(G, dt);
    }
    updateParticles(G, dt);
    // A fresh HUD message stays visible for ~3.5 seconds.
    if (G.hudMessage && G.hudMessage !== G._lastHudMessage) {
      G._lastHudMessage = G.hudMessage;
      G.hudMessageUntil = (G.time ? G.time.t : 0) + 3.5;
    }
  } finally {
    // Restore the live input for the next frame's listeners.
    G.input = realInput;
  }
}

// The living city behind the title screen: traffic + pedestrians move,
// the clock turns, but no police, combat or missions run.
function stepTitleBackground(G, dt) {
  updateClock(G, dt * 0.5);
  updateTraffic(G, dt);
  updatePedestrians(G, dt);
  updateParticles(G, dt);
}

// --- DOM overlays ----------------------------------------------------------

function el(id) {
  return (typeof document !== 'undefined') ? document.getElementById(id) : null;
}

function showOnly(id) {
  for (const other of ['title-screen', 'pause-menu', 'game-over-screen']) {
    const node = el(other);
    if (node) node.style.display = other === id ? 'flex' : 'none';
  }
}

function renderSlotList(G) {
  const list = el('save-slots');
  if (!list) return;
  const slots = listSaveSlots();
  list.innerHTML = '';
  for (const s of slots) {
    const btn = document.createElement('button');
    btn.className = 'slot-btn';
    btn.dataset.slot = String(s.slot);
    btn.textContent = `Slot ${s.slot + 1} — ${s.label}`;
    if (s.corrupt) btn.classList.add('slot-corrupt');
    if (s.slot === G.selectedSlot) btn.classList.add('slot-selected');
    btn.addEventListener('click', () => {
      G.selectedSlot = s.slot;
      renderSlotList(G);
      const cont = el('continue-btn');
      if (cont) cont.disabled = s.empty || s.corrupt;
    });
    list.appendChild(btn);
  }
  const cont = el('continue-btn');
  if (cont) {
    const chosen = slots[G.selectedSlot];
    cont.disabled = !chosen || chosen.empty || chosen.corrupt;
  }
}

function startNewGame(G) {
  const fresh = createGameState();
  // Keep the same canvas / input / audio wiring: copy the fresh state
  // over G in place so every closure keeps pointing at the same object.
  const keep = {
    systems: G.systems,
    input: G._realInput,
    autoInput: G.autoInput,
    staticLayer: G.staticLayer,
    minimapLayer: G.minimapLayer,
    canvas: G.canvas,
    ctx: G.ctx,
    audio: G.audio,
    audioEngine: G.audioEngine,
    selectedSlot: G.selectedSlot,
  };
  for (const key of Object.keys(G)) delete G[key];
  Object.assign(G, fresh);
  G.systems = keep.systems;
  G._realInput = keep.input;
  G.input = keep.input;
  G.autoInput = keep.autoInput;
  G.staticLayer = keep.staticLayer;
  G.minimapLayer = keep.minimapLayer;
  G.canvas = keep.canvas;
  G.ctx = keep.ctx;
  G.audio = keep.audio;
  G.audioEngine = keep.audioEngine;
  G.selectedSlot = keep.selectedSlot;
  G.activeSlot = keep.selectedSlot;
  G.state = 'playing';
  bootWorldEntities(G);
  showOnly(null);
  if (G.audio) G.audio.play && G.audio.play('uiClick');
}

function continueGame(G) {
  const res = loadGame(G, G.selectedSlot);
  if (!res.ok) {
    const msg = el('title-message');
    if (msg) msg.textContent = res.corrupt ? 'That save is corrupt — pick another slot or start a new game.' : 'That slot is empty.';
    return;
  }
  G.state = 'playing';
  showOnly(null);
  if (G.audio) G.audio.play && G.audio.play('uiClick');
}

function pauseGame(G) {
  if (G.state !== 'playing') return;
  G.state = 'paused';
  G.paused = true;
  showOnly('pause-menu');
}

function resumeGame(G) {
  if (G.state !== 'paused') return;
  G.state = 'playing';
  G.paused = false;
  showOnly(null);
}

function gameOver(G, reason) {
  if (G.state === 'gameover') return;
  G.state = 'gameover';
  G.caughtReason = reason || 'DOWN';
  const title = el('game-over-title');
  if (title) title.textContent = G.caughtReason === 'CAUGHT' ? 'CAUGHT' : 'DOWN';
  const sub = el('game-over-sub');
  if (sub) {
    sub.textContent = G.caughtReason === 'CAUGHT'
      ? 'The police took you in. You lose 20% of your cash — but the city is still yours.'
      : 'You went down. You lose 20% of your cash — but the city is still yours.';
  }
  showOnly('game-over-screen');
}

function respawn(G) {
  const p = G.player;
  p.health = p.maxHealth;
  p.cash = Math.floor((p.cash || 0) * 0.8);
  p.x = 600;
  p.y = 800;
  p.onFoot = true;
  p.car = null;
  p.speed = 0;
  G.heat = 0;
  G.stars = 0;
  if (G.police) {
    G.police.footCops = [];
    G.police.patrolCars = [];
    G.police.roadblocks = [];
  }
  if (G.helicopter) {
    G.helicopter.active = false;
    G.helicopter.state = 'off';
    G.helicopter.spotlightOnPlayer = false;
  }
  // A failed mission restarts from its stage 0 on the next garage visit.
  if (G.mission && G.mission.state === 'active' && G.systems.missions) {
    G.systems.missions.failMission(G, G.caughtReason || 'down');
  }
  G.state = 'playing';
  showOnly(null);
}

function wireOverlays(G) {
  const newBtn = el('new-game-btn');
  if (newBtn) newBtn.addEventListener('click', () => startNewGame(G));
  const contBtn = el('continue-btn');
  if (contBtn) contBtn.addEventListener('click', () => continueGame(G));
  const resumeBtn = el('resume-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => resumeGame(G));
  const saveBtn = el('save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const res = saveGame(G);
      const msg = el('pause-message');
      if (msg) msg.textContent = res.ok ? `Saved to slot ${res.slot + 1}.` : 'Save failed.';
    });
  }
  const quitBtn = el('quit-btn');
  if (quitBtn) {
    quitBtn.addEventListener('click', () => {
      G.state = 'title';
      G.paused = false;
      renderSlotList(G);
      showOnly('title-screen');
    });
  }
  const respawnBtn = el('respawn-btn');
  if (respawnBtn) respawnBtn.addEventListener('click', () => respawn(G));
  const titleBtn = el('game-over-title-btn');
  if (titleBtn) {
    titleBtn.addEventListener('click', () => {
      G.state = 'title';
      renderSlotList(G);
      showOnly('title-screen');
    });
  }
}

// --- world entities ----------------------------------------------------------

function bootWorldEntities(G) {
  if (!G._booted) {
    spawnParkedCars(G, 26);
    spawnWorldCrates(G);
    G._booted = true;
  }
}

// --- boot ------------------------------------------------------------------

// Start the game in a browser: canvas, input, audio, systems, loop.
// Returns the game state G (also exposed as window.__game for the
// playtest harness).
export async function startGame() {
  const canvas = el('game-canvas');
  if (!canvas) throw new Error('no #game-canvas in the page');
  const ctx = canvas.getContext('2d');
  const G = createGameState();
  G.canvas = canvas;
  G.ctx = ctx;

  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize);

  attachInput(G.input, canvas);
  const engine = createAudioEngine();
  engine.attachToGame(G);
  G.audioEngine = engine;

  await wireSystems(G);
  G.staticLayer = createStaticLayer(G.world);
  bootWorldEntities(G);
  G.activeSlot = defaultActiveSlot();
  G.selectedSlot = G.activeSlot;

  // Caught / down hooks: police arrest and combat damage call these.
  G.onCaught = () => gameOver(G, 'CAUGHT');
  G.onPlayerDown = () => gameOver(G, 'DOWN');
  // Autosave hook: after each mission, write the active slot.
  G.onMissionComplete = () => { autosave(G); };

  wireOverlays(G);
  renderSlotList(G);
  showOnly('title-screen');

  // Playtest hooks (bound to this state, so they never lose context).
  window.__game = G;
  window.__crescent = {
    G,
    startMission: (id) => (G.systems.missions ? G.systems.missions.startMission(G, id) : false),
    addHeat: (n) => G.addHeat(n),
    saveGame: (slot) => saveGame(G, slot),
    loadGame: (slot) => loadGame(G, slot),
    listSaveSlots: () => listSaveSlots(),
  };

  // Fixed-timestep loop: 1/60s steps, render every animation frame.
  const STEP = 1 / 60;
  let last = performance.now();
  let acc = 0;
  let fpsFrames = 0;
  let fpsTime = 0;

  function frame(now) {
    const elapsed = Math.min(0.25, (now - last) / 1000);
    last = now;
    fpsFrames++;
    fpsTime += elapsed;
    if (fpsTime >= 1) {
      G.fps = Math.round(fpsFrames / fpsTime);
      fpsFrames = 0;
      fpsTime = 0;
    }
    acc += elapsed;

    // Pause toggle BEFORE the early exit: once paused, the key must
    // still be seen (v1 bug: pause could be entered but never left).
    const input = G._realInput || G.input;
    const pausePressed = input.pressed && (input.pressed.has('Escape') || input.pressed.has('KeyP'));
    const garageOpen = G.garage && G.garage.open;
    if (pausePressed && !garageOpen) {
      if (G.state === 'playing') pauseGame(G);
      else if (G.state === 'paused') resumeGame(G);
    }

    let steps = 0;
    while (acc >= STEP && steps < 5) {
      acc -= STEP;
      steps++;
      G._frame++;
      if (G.state === 'playing' && !G.paused) {
        stepGame(G, STEP);
      } else if (G.state === 'title') {
        stepTitleBackground(G, STEP);
      }
      // Paused / game-over: the world freezes, the frame still renders.
    }
    if (steps >= 5) acc = 0;

    updateCamera(G, canvas);
    drawScene(ctx, G, G.systems);

    // Edge flags are cleared at the END of the frame, after every
    // system has read them — never before.
    clearEdgeFlags(G._realInput || G.input);
    clearEdgeFlags(G.autoInput);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return G;
}

// Auto-boot when loaded as a module in a browser page.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startGame().catch((err) => console.error('[crescent] boot failed', err));
    });
  } else {
    startGame().catch((err) => console.error('[crescent] boot failed', err));
  }
}
