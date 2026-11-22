// tools/playtest.mjs — Crescent Bay playtest harness (Builder C-2, fresh).
//
// Modes:
//   node tools/playtest.mjs cold          fresh profile, title -> play, 10 checks
//   node tools/playtest.mjs edge          wall / cars / wanted / saves / radio /
//                                         weapons / helicopter / garage / game-over, 14 checks
//   node tools/playtest.mjs arc [m1..m12] full 12-mission arc by autopilot, or one
//                                         mission in isolation (m11 gets cash first)
//   node tools/playtest.mjs fps           frames per second during a wanted chase
//
// Every mode serves game/ on port 8931, drives headless Chromium
// (chromium_headless_shell-1255, cached), collects console errors and
// page errors, prints PASS/FAIL per check and writes a JSON report to
// tools/playtest-<mode>[<id>].json. Exit 0 only when every check passes.
// The arc run appends one state line per mission every 2s to
// /tmp/arc-progress.txt so a kill or VM restart still leaves a trail.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTABLE = join(
  homedir(),
  '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell',
);
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const ARC_PROGRESS = '/tmp/arc-progress.txt';
const MISSION_IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  throw new Error(msg);
}

function checkEq(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${expected}, got ${actual}`);
}

function checkTrue(cond, what) {
  if (!cond) fail(what);
}

// --- server ---------------------------------------------------------------

let serverProc = null;

async function startServer() {
  serverProc = spawn('node', ['serve.ts', '--port', String(PORT)], { cwd: REPO });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const res = await fetch(`${BASE}/index.html`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  fail('serve.ts did not answer on port ' + PORT);
}

function stopServer() {
  if (serverProc) {
    serverProc.kill('SIGTERM');
    serverProc = null;
  }
}

// --- browser --------------------------------------------------------------

async function freshPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return { ctx, page, errors };
}

// One snapshot of everything the suites assert on. Reads only the
// public playtest hooks (window.__game / window.__crescent) that
// main.js exposes for the harness.
async function snap(page) {
  return page.evaluate(() => {
    const G = window.__game;
    if (!G) return { ready: false };
    return {
      ready: true,
      state: G.state,
      px: Math.round(G.player.x),
      py: Math.round(G.player.y),
      onFoot: G.player.onFoot,
      speed: Math.round(G.player.speed || 0),
      health: Math.round(G.player.health),
      cash: G.player.cash,
      heat: Math.round(G.heat),
      stars: G.stars,
      missionId: (G.mission && G.mission.id) || null,
      missionState: (G.mission && G.mission.state) || 'none',
      stage: (G.mission && G.mission.stage) ?? -1,
      completed: [...((G.mission && G.mission.completed) || [])],
      timeLeft: Math.round((G.mission && G.mission.timeLeft) || 0),
      fps: G.fps || 0,
      enemies: (G.enemies || []).length,
      heli: G.helicopter
        ? { active: G.helicopter.active, state: G.helicopter.state, spotlight: !!G.helicopter.spotlightOnPlayer }
        : null,
      weapon: G.weapons ? G.weapons.current : null,
      ammo: G.weapons ? { ...G.weapons.ammo } : null,
      owned: G.weapons ? { ...G.weapons.owned } : null,
      radio: G.systems && G.systems.radio ? G.systems.radio.currentStationName(G) : null,
      garageOpen: !!(G.garage && G.garage.open),
      purchases: G.systems && G.systems.garage ? G.systems.garage.garagePurchaseCount(G) : 0,
      roadblocks: (G.police && G.police.roadblocks ? G.police.roadblocks.length : 0),
      night: (G.time && G.time.night) || 0,
      hour: (G.time && Math.round(G.time.hour)) || 0,
    };
  });
}

// Poll a page-side boolean expression (a string, evaluated in the
// page) until it is true or the timeout elapses.
async function waitFor(page, expr, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // The expression is an arrow function as a string: call it, or
    // Playwright returns the function itself (undefined) and the
    // wait never ends.
    if (await page.evaluate(`(${expr})()`)) return true;
    await sleep(250);
  }
  fail('timeout waiting for: ' + label);
}

async function newGame(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
  await waitFor(page, `() => !!window.__game`, 10000, 'game state to exist');
  await page.click('#new-game-btn');
  await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 5000, 'state playing');
}

// Teleport the player next to the nearest parked car (harness
// positioning only — the game itself is never modified) and return
// the car's distance before the move.
async function moveNextToParkedCar(page) {
  return page.evaluate(() => {
    const G = window.__game;
    let best = null;
    let bestD = Infinity;
    for (const c of G.cars || []) {
      if (!c.parked) continue;
      const d = Math.hypot(c.x - G.player.x, c.y - G.player.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return -1;
    G.player.x = best.x + 40;
    G.player.y = best.y;
    return Math.round(bestD);
  });
}

// --- suite bookkeeping ------------------------------------------------------

class Suite {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }

  async check(name, fn) {
    try {
      const detail = await fn();
      this.checks.push({ name, pass: true, detail: detail === undefined ? '' : String(detail) });
      console.log(`  PASS ${name}`);
    } catch (e) {
      this.checks.push({ name, pass: false, detail: String((e && e.message) || e) });
      console.log(`  FAIL ${name}: ${(e && e.message) || e}`);
    }
  }

  get passed() {
    return this.checks.filter((c) => c.pass).length;
  }

  get total() {
    return this.checks.length;
  }

  report() {
    const out = {
      suite: this.name,
      passed: this.passed,
      total: this.total,
      at: new Date().toISOString(),
      checks: this.checks,
    };
    const file = join(REPO, 'tools', `playtest-${this.name}.json`);
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log(`${this.name}: ${this.passed}/${this.total} passed (report ${file})`);
    return this.passed === this.total;
  }
}

// --- cold suite -------------------------------------------------------------

async function runCold(browser) {
  const suite = new Suite('cold');
  const { ctx, page, errors } = await freshPage(browser);
  try {
    let loadMs = 0;
    await suite.check('title appears in under 2s', async () => {
      const t0 = Date.now();
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
      loadMs = Date.now() - t0;
      checkTrue(loadMs < 2000, `title took ${loadMs}ms`);
      return `${loadMs}ms`;
    });

    await suite.check('new game starts', async () => {
      await page.click('#new-game-btn');
      await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 5000, 'state playing');
      return 'state=playing';
    });

    await suite.check('player walks on foot', async () => {
      const before = await snap(page);
      await page.keyboard.down('KeyW');
      await sleep(1200);
      await page.keyboard.up('KeyW');
      const after = await snap(page);
      const moved = Math.hypot(after.px - before.px, after.py - before.py);
      checkTrue(moved >= 30, `moved only ${Math.round(moved)} units`);
      return `moved ${Math.round(moved)} units`;
    });

    await suite.check('player enters a parked car', async () => {
      const dist = await moveNextToParkedCar(page);
      checkTrue(dist >= 0, 'no parked car found');
      await page.keyboard.press('KeyE');
      await waitFor(page, `() => window.__game && !window.__game.player.onFoot`, 5000, 'player in car');
      return `nearest parked car was ${dist} units away`;
    });

    await suite.check('player drives', async () => {
      await page.keyboard.down('KeyW');
      await sleep(2000);
      const s = await snap(page);
      await page.keyboard.up('KeyW');
      checkTrue(!s.onFoot, 'player is on foot, not driving');
      checkTrue(s.speed > 50, `speed only ${s.speed}`);
      return `in car, speed ${s.speed}`;
    });

    await suite.check('player exits and shoots', async () => {
      await page.keyboard.press('KeyE');
      await waitFor(page, `() => window.__game && window.__game.player.onFoot`, 5000, 'player on foot');
      const before = await snap(page);
      await page.mouse.click(700, 350);
      await sleep(300);
      const after = await snap(page);
      checkEq(after.ammo.pistol, before.ammo.pistol - 1, 'pistol ammo after one click');
      return `ammo ${before.ammo.pistol} -> ${after.ammo.pistol}`;
    });

    await suite.check('pause then resume', async () => {
      await page.keyboard.press('Escape');
      await waitFor(page, `() => window.__game && window.__game.state === 'paused'`, 3000, 'state paused');
      await page.waitForSelector('#pause-menu:visible', { timeout: 3000 });
      await page.keyboard.press('Escape');
      await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 3000, 'state playing again');
      return 'paused -> playing';
    });

    await suite.check('HUD canvas is live', async () => {
      const info = await page.evaluate(() => {
        const c = document.querySelector('#game-canvas');
        const url = c ? c.toDataURL('image/png') : '';
        return { w: c ? c.width : 0, dataLen: url.length, hud: !!window.__game.systems.hud };
      });
      checkTrue(info.w === 1280, `canvas width ${info.w}`);
      checkTrue(info.dataLen > 30000, `canvas data URL only ${info.dataLen} chars (blank?)`);
      checkTrue(info.hud, 'hud module not loaded');
      return `canvas ${info.w}px, data ${info.dataLen} chars`;
    });

    await suite.check('mission dialog opens and accepts with E', async () => {
      const started = await page.evaluate(() => window.__crescent.startMission('m1'));
      checkTrue(started, 'startMission(m1) returned false');
      await page.waitForSelector('#mission-dialog:visible', { timeout: 5000 });
      await page.keyboard.press('KeyE');
      await waitFor(page, `() => window.__game && window.__game.mission.state === 'active'`, 5000, 'mission active');
      return 'm1 dialog -> active';
    });

    await suite.check('zero console errors', async () => {
      checkEq(errors.length, 0, 'console/page errors');
      return 'clean';
    });
  } finally {
    await ctx.close();
  }
  return suite.report();
}

// --- edge suite -------------------------------------------------------------

async function runEdge(browser) {
  const suite = new Suite('edge');
  const { ctx, page, errors } = await freshPage(browser);
  try {
    await newGame(page);

    await suite.check('walls block the player', async () => {
      const setup = await page.evaluate(() => {
        const G = window.__game;
        const b = G.world.buildings[0];
        G.player.x = b.x - 20;
        G.player.y = b.y + b.h / 2;
        return { x: b.x, y: b.y, w: b.w, h: b.h };
      });
      await page.keyboard.down('KeyD');
      await sleep(2000);
      await page.keyboard.up('KeyD');
      const s = await snap(page);
      const inside =
        s.px > setup.x && s.px < setup.x + setup.w && s.py > setup.y && s.py < setup.y + setup.h;
      checkTrue(!inside, `player ended inside building at (${s.px}, ${s.py})`);
      return `pushed east into building at (${setup.x}, ${setup.y}), stopped outside`;
    });

    await suite.check('enter and exit a car five times', async () => {
      for (let i = 0; i < 5; i++) {
        const dist = await moveNextToParkedCar(page);
        checkTrue(dist >= 0, `round ${i + 1}: no parked car found`);
        await page.keyboard.press('KeyE');
        await waitFor(page, `() => window.__game && !window.__game.player.onFoot`, 5000, `round ${i + 1} enter`);
        await page.keyboard.press('KeyE');
        await waitFor(page, `() => window.__game && window.__game.player.onFoot`, 5000, `round ${i + 1} exit`);
      }
      return '5 enter/exit cycles';
    });

    await suite.check('spray shop clears 5 stars to 0', async () => {
      await page.evaluate(() => window.__crescent.addHeat(95));
      await waitFor(page, `() => window.__game && window.__game.stars >= 5`, 5000, 'stars 5');
      await page.evaluate(() => {
        const G = window.__game;
        G.player.x = 1000;
        G.player.y = 2600;
        if (G.player.car) {
          G.player.car.x = 1000;
          G.player.car.y = 2600;
        }
      });
      await waitFor(
        page,
        `() => window.__game && window.__game.heat < 5 && window.__game.stars === 0`,
        20000,
        'heat drained to 0 stars',
      );
      return 'heat 95 -> <5, stars 5 -> 0';
    });

    await suite.check('pause save reload continue restores cash', async () => {
      await page.evaluate(() => {
        window.__game.player.cash = 1234;
      });
      await page.keyboard.press('Escape');
      await page.waitForSelector('#pause-menu:visible', { timeout: 3000 });
      await page.click('#save-btn');
      await page.waitForFunction(
        () => (document.querySelector('#pause-message') || {}).textContent.includes('Saved'),
        { timeout: 5000 },
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
      await page.click('.slot-btn');
      await page.click('#continue-btn');
      await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 5000, 'state playing');
      const s = await snap(page);
      checkEq(s.cash, 1234, 'cash after Continue');
      return 'cash 1234 restored';
    });

    await suite.check('corrupt save starts fresh without crashing', async () => {
      await page.evaluate(() => {
        localStorage.setItem('crescent-bay-save-v1-slot-0', '{"version":99,"broken":');
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
      const corrupt = await page.evaluate(() => window.__crescent.listSaveSlots()[0].corrupt);
      checkTrue(corrupt, 'slot 0 not flagged corrupt');
      await page.click('#new-game-btn');
      await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 5000, 'state playing');
      return 'slot 0 corrupt, new game still starts';
    });

    await suite.check('radio cycles all three stations', async () => {
      const names = [];
      const readName = () =>
        page.evaluate(() => window.__game.systems.radio.currentStationName(window.__game));
      names.push(await readName());
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('KeyR');
        await sleep(400);
        names.push(await readName());
        checkTrue(names[i + 1] !== names[i], `station did not change on press ${i + 1} (still ${names[i]})`);
      }
      checkEq(new Set(names.slice(0, 3)).size, 3, 'distinct stations seen');
      checkEq(names[3], names[0], 'fourth press did not wrap back to the first station');
      return names.slice(0, 3).join(' -> ');
    });

    await suite.check('all three save slots round-trip', async () => {
      for (let slot = 0; slot < 3; slot++) {
        const want = 100 * (slot + 1);
        const saved = await page.evaluate((s) => {
          window.__game.player.cash = 100 * (s + 1);
          return window.__crescent.saveGame(s);
        }, slot);
        checkTrue(saved && saved.ok, `save to slot ${slot + 1} failed`);
        const loaded = await page.evaluate((s) => window.__crescent.loadGame(s), slot);
        checkTrue(loaded && loaded.ok, `load from slot ${slot + 1} failed`);
        const s = await snap(page);
        checkEq(s.cash, want, `cash after loading slot ${slot + 1}`);
      }
      const slots = await page.evaluate(() => window.__crescent.listSaveSlots());
      checkTrue(slots.every((x) => !x.empty), 'a slot still shows empty');
      return 'slots 1-3: cash 100 / 200 / 300 restored';
    });

    await suite.check('weapon crate pickup grants the SMG', async () => {
      const s0 = await snap(page);
      if (!s0.onFoot) {
        await page.keyboard.press('KeyE');
        await waitFor(page, `() => window.__game && window.__game.player.onFoot`, 5000, 'player on foot');
      }
      const moved = await page.evaluate(() => {
        const G = window.__game;
        const crate = (G.crates || []).find((c) => c.kind === 'smg' && !c.taken);
        if (!crate) return false;
        G.player.x = crate.x;
        G.player.y = crate.y;
        return true;
      });
      checkTrue(moved, 'no untaken SMG crate found');
      await waitFor(page, `() => window.__game && window.__game.weapons.owned.smg`, 5000, 'SMG owned');
      return 'walked over the gun-store SMG crate';
    });

    await suite.check('weapon switching with 1 2 3 and Q', async () => {
      await page.evaluate(() => {
        const w = window.__game.systems.weapons;
        w.giveWeapon(window.__game, 'smg');
        w.giveWeapon(window.__game, 'shotgun');
      });
      await page.keyboard.press('Digit2');
      await sleep(200);
      checkEq((await snap(page)).weapon, 'smg', 'weapon after pressing 2');
      await page.keyboard.press('Digit3');
      await sleep(200);
      checkEq((await snap(page)).weapon, 'shotgun', 'weapon after pressing 3');
      await page.keyboard.press('KeyQ');
      await sleep(200);
      checkEq((await snap(page)).weapon, 'pistol', 'weapon after Q from shotgun');
      await page.keyboard.press('Digit1');
      await sleep(200);
      checkEq((await snap(page)).weapon, 'pistol', 'weapon after pressing 1');
      return '2 -> smg, 3 -> shotgun, Q -> pistol, 1 -> pistol';
    });

    await suite.check('helicopter shadows at 3 stars', async () => {
      await page.evaluate(() => window.__crescent.addHeat(60));
      await waitFor(page, `() => window.__game && window.__game.helicopter && window.__game.helicopter.active`, 8000, 'heli active');
      await sleep(2000);
      const s = await snap(page);
      checkEq(s.heli.state, 'shadowing', 'heli state');
      checkTrue(s.heli.spotlight, 'spotlight not on the player');
      return `heli ${s.heli.state}, spotlight on, stars ${s.stars}`;
    });

    await suite.check('helicopter retreats when shot down', async () => {
      await page.evaluate(() => {
        window.__game.systems.helicopter.takeHelicopterDamage(window.__game, 10000);
      });
      await waitFor(
        page,
        `() => window.__game && (window.__game.helicopter.state === 'smoking' || window.__game.helicopter.state === 'retreating')`,
        5000,
        'heli smoking or retreating',
      );
      const s = await snap(page);
      return `heli ${s.heli.state}`;
    });

    await suite.check('garage purchase works from the menu', async () => {
      await page.evaluate(() => {
        const G = window.__game;
        G.player.cash = 5000;
        G.heat = 0;
        G.stars = 0;
        G.player.x = 600;
        G.player.y = 1000;
      });
      await page.keyboard.press('KeyE');
      await page.waitForSelector('#garage-menu:visible', { timeout: 5000 });
      const before = (await snap(page)).purchases;
      const cashBefore = (await snap(page)).cash;
      await page.click('#garage-menu button[data-upgrade]:not([disabled])');
      await sleep(500);
      const after = await snap(page);
      checkEq(after.purchases, before + 1, 'purchase count after buying');
      checkTrue(after.cash < cashBefore, `cash did not drop (${cashBefore} -> ${after.cash})`);
      await page.click('#garage-menu button[data-close]');
      await waitFor(page, `() => window.__game && !window.__game.garage.open && window.__game.state === 'playing'`, 5000, 'menu closed');
      return `purchase ${before} -> ${after.purchases}, cash ${cashBefore} -> ${after.cash}`;
    });

    await suite.check('game over respawn keeps the game going', async () => {
      await page.evaluate(() => {
        window.__game.systems.combat.damagePlayer(window.__game, 500);
      });
      await page.waitForSelector('#game-over-screen:visible', { timeout: 5000 });
      const title = await page.textContent('#game-over-title');
      checkTrue(title === 'DOWN' || title === 'CAUGHT', `game-over title was ${title}`);
      await page.click('#respawn-btn');
      await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 5000, 'state playing');
      const s = await snap(page);
      checkEq(s.health, 100, 'health after respawn');
      checkEq(s.heat, 0, 'heat after respawn');
      return `game over ${title}, respawned at full health`;
    });

    await suite.check('zero console errors', async () => {
      checkEq(errors.length, 0, 'console/page errors: ' + errors.join(' | '));
      return 'clean';
    });
  } finally {
    await ctx.close();
  }
  return suite.report();
}

// --- fps suite --------------------------------------------------------------

async function runFps(browser) {
  const suite = new Suite('fps');
  const { ctx, page, errors } = await freshPage(browser);
  try {
    await newGame(page);
    await page.evaluate(() => {
      window.__game.systems.autopilot.enableAutopilot(window.__game);
      window.__crescent.addHeat(60);
    });
    await sleep(3000);
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const s = await snap(page);
      samples.push(s.fps);
      await sleep(500);
    }
    const valid = samples.filter((f) => f > 0);
    const avg = valid.reduce((a, b) => a + b, 0) / Math.max(1, valid.length);
    const min = Math.min(...valid);
    await suite.check('fps at least 50 in a wanted chase', async () => {
      checkTrue(avg >= 50, `average FPS ${avg.toFixed(1)} (min ${min}, samples ${valid.length})`);
      return `avg ${avg.toFixed(1)}, min ${min}, max ${Math.max(...valid)} over ${valid.length} samples`;
    });
    await suite.check('zero console errors', async () => {
      checkEq(errors.length, 0, 'console/page errors: ' + errors.join(' | '));
      return 'clean';
    });
  } finally {
    await ctx.close();
  }
  return suite.report();
}

// --- arc suite --------------------------------------------------------------

async function runArc(browser, filter) {
  const single = filter || null;
  const name = single ? `arc-${single}` : 'arc';
  const suite = new Suite(name);
  const results = {
    mode: 'arc',
    filter: single,
    at: new Date().toISOString(),
    missions: {},
    flags: { heliSeenM9: false, heliSeenM12: false, weaponUsedM10: false, garagePurchaseM11: false },
    errors: [],
  };
  const { ctx, page, errors } = await freshPage(browser);
  try {
    await newGame(page);
    if (single === 'm11') {
      await page.evaluate(() => {
        window.__game.player.cash = 5000;
      });
    }
    await page.evaluate(() => {
      window.__game.systems.autopilot.enableAutopilot(window.__game);
    });
    const first = single || 'm1';
    const started = await page.evaluate((id) => window.__crescent.startMission(id), first);
    checkTrue(started, `startMission(${first}) returned false`);

    const targetIds = single ? [single] : MISSION_IDS;
    const completedAt = {};
    const missionStart = {};
    let currentMission = first;
    let missionDeadline = 0;
    let purchasesAtM11Start = 0;
    const t0 = Date.now();
    const overallDeadline = t0 + 3600 * 1000;
    let lastLog = 0;

    const progress = (s) => {
      const line =
        `[${new Date().toISOString()}] mission=${s.missionId || '-'} state=${s.missionState} ` +
        `stage=${s.stage} completed=${s.completed.join(',') || '-'} pos=(${s.px},${s.py}) ` +
        `stars=${s.stars} heli=${s.heli ? s.heli.state : '-'} fps=${s.fps} ` +
        `timeLeft=${s.timeLeft}s errors=${errors.length}`;
      appendFileSync(ARC_PROGRESS, line + '\n');
    };

    let done = false;
    while (Date.now() < overallDeadline) {
      const s = await snap(page);
      const now = Date.now();

      if (now - lastLog >= 2000) {
        progress(s);
        lastLog = now;
      }

      // Track per-mission flags while the mission is live.
      if (s.missionId === 'm9' && s.heli && s.heli.active) results.flags.heliSeenM9 = true;
      if (s.missionId === 'm12' && s.heli && s.heli.active) results.flags.heliSeenM12 = true;
      if (s.missionId === 'm10' && (s.owned.smg || s.owned.shotgun) && s.weapon !== 'pistol') {
        results.flags.weaponUsedM10 = true;
      }
      if (s.missionId === 'm11') {
        if (s.stage === 0 && purchasesAtM11Start === 0) purchasesAtM11Start = s.purchases;
        if (s.purchases > purchasesAtM11Start) results.flags.garagePurchaseM11 = true;
      }

      // A mission just became active: arm its wall-clock deadline.
      if (s.missionState === 'active' && s.missionId && s.missionId !== currentMission) {
        currentMission = s.missionId;
        const limit = (MISSION_IDS.indexOf(s.missionId) >= 0
          ? (await page.evaluate(
              (id) => {
                const m = window.__game.systems.missions.missionDef(id);
                return m ? m.timeLimit : 300;
              },
              s.missionId,
            ))
          : 300) + 300;
        missionStart[s.missionId] = now;
        missionDeadline = now + limit * 1000;
        console.log(`  arc: ${s.missionId} active, deadline ${limit}s`);
      }

      // Record completions.
      for (const id of s.completed) {
        if (!(id in completedAt)) {
          completedAt[id] = now;
          const startedAt = missionStart[id] || t0;
          results.missions[id] = { seconds: Math.round((now - startedAt) / 1000) };
          console.log(`  arc: ${id} complete in ${results.missions[id].seconds}s`);
        }
      }

      if (targetIds.every((id) => s.completed.includes(id))) {
        done = true;
        break;
      }

      if (s.state === 'gameover') {
        // The autopilot cannot click Respawn; do it for the run and let
        // the mission retry from the garage.
        console.log('  arc: game over, respawning');
        await page.click('#respawn-btn').catch(() => {});
        await sleep(1000);
      }

      if (missionDeadline && now > missionDeadline && s.missionState === 'active') {
        fail(
          `mission ${s.missionId} exceeded its wall deadline ` +
            `(stage ${s.stage}, pos ${s.px},${s.py}, stars ${s.stars}, ` +
            `completed ${s.completed.join(',') || '-'})`,
        );
      }
      if (errors.length > 0) {
        fail('console/page error during arc: ' + errors[0]);
      }
      await sleep(1000);
    }
    if (!done) fail('arc overall deadline (3600s) reached');

    await suite.check(single ? `${single} completes by autopilot` : 'all 12 missions complete by autopilot', async () => {
      const s = await snap(page);
      for (const id of targetIds) checkTrue(s.completed.includes(id), `mission ${id} not completed`);
      return `${targetIds.join(', ')} in ${Math.round((Date.now() - t0) / 1000)}s total`;
    });
    if (!single) {
      await suite.check('helicopter appears in the m9 arc run', async () => {
        checkTrue(results.flags.heliSeenM9, 'no active helicopter seen during m9');
        return 'heli active during m9';
      });
      await suite.check('helicopter appears in the m12 arc run', async () => {
        checkTrue(results.flags.heliSeenM12, 'no active helicopter seen during m12');
        return 'heli active during m12';
      });
      await suite.check('weapon switching and pickups in the m10 run', async () => {
        checkTrue(results.flags.weaponUsedM10, 'no non-pistol weapon used during m10');
        return 'SMG/shotgun used during m10';
      });
      await suite.check('garage purchase in the m11 run', async () => {
        checkTrue(results.flags.garagePurchaseM11, 'no garage purchase during m11');
        return 'purchase made during m11';
      });
    }
    await suite.check('zero console errors', async () => {
      checkEq(errors.length, 0, 'console/page errors: ' + errors.join(' | '));
      return 'clean';
    });
  } catch (e) {
    suite.checks.push({ name: 'arc run', pass: false, detail: String((e && e.message) || e) });
    console.log(`  FAIL arc run: ${(e && e.message) || e}`);
    results.errors = errors;
  } finally {
    await ctx.close();
  }
  results.missions = { ...results.missions };
  results.passed = suite.passed;
  results.total = suite.total;
  const file = join(REPO, 'tools', `playtest-${name}.json`);
  writeFileSync(file, JSON.stringify({ ...results, checks: suite.checks }, null, 2) + '\n');
  console.log(`${name}: ${suite.passed}/${suite.total} passed (report ${file})`);
  return suite.passed === suite.total;
}

// --- main -------------------------------------------------------------------

async function main() {
  const mode = process.argv[2];
  const filter = process.argv[3] || null;
  if (!['cold', 'edge', 'arc', 'fps'].includes(mode)) {
    console.log('usage: node tools/playtest.mjs <cold|edge|arc|fps> [missionId]');
    process.exit(2);
  }
  if (filter && !MISSION_IDS.includes(filter)) {
    console.log(`unknown mission ${filter} (want one of ${MISSION_IDS.join(' ')})`);
    process.exit(2);
  }
  await startServer();
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--mute-audio'] });
  let ok = false;
  try {
    if (mode === 'cold') ok = await runCold(browser);
    else if (mode === 'edge') ok = await runEdge(browser);
    else if (mode === 'fps') ok = await runFps(browser);
    else ok = await runArc(browser, filter);
  } finally {
    await browser.close();
    stopServer();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('playtest crashed:', (e && e.message) || e);
  stopServer();
  process.exit(1);
});
