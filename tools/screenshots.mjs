// tools/screenshots.mjs — Crescent Bay screenshot poses (Builder C-2, fresh).
//
// Takes the four shots from shots.json at 1280x800, JPEG quality 80,
// deterministic pose seed 7, each target <= 200 KiB. Every pose is
// played by the autopilot from a fresh world — never hand-placed:
// the cover waits for the m7 escape stage near the waterfront, the
// mission shot waits for the m8 shootout in progress, the night shot
// waits for a 4-star roadblock chase at night, the start shot is the
// title over the living city. If a shot comes out over 200 KiB it is
// retaken at lower quality (70, then 55). Zero console errors are
// asserted per pose. Writes tools/screenshots.json with sizes.
//
// Usage: node tools/screenshots.mjs [shot-id]   (no arg = all four)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTABLE = join(
  homedir(),
  '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell',
);
const PORT = 8932;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = [
  { id: 'cover', file: '1-cover.jpg' },
  { id: 'mission', file: '2-mission.jpg' },
  { id: 'night', file: '3-night.jpg' },
  { id: 'start', file: '4-start.jpg' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  throw new Error(msg);
};

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

async function snapState(page) {
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
      stars: G.stars,
      heat: Math.round(G.heat),
      missionId: (G.mission && G.mission.id) || null,
      missionState: (G.mission && G.mission.state) || 'none',
      stage: (G.mission && G.mission.stage) ?? -1,
      enemies: (G.enemies || []).length,
      ammo: G.weapons ? G.weapons.ammo.pistol : 0,
      roadblocks: (G.police && G.police.roadblocks ? G.police.roadblocks.length : 0),
      night: (G.time && G.time.night) || 0,
      dialogOpen: !!(G.mission && G.mission.dialogOpen),
    };
  });
}

async function startPlaying(page, missionId) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
  await waitFor(page, `() => !!window.__game`, 10000, 'game state to exist');
  await page.click('#new-game-btn');
  await waitFor(page, `() => window.__game && window.__game.state === 'playing'`, 5000, 'state playing');
  await page.evaluate(() => {
    window.__game.systems.autopilot.enableAutopilot(window.__game);
  });
  if (missionId) {
    const started = await page.evaluate((id) => window.__crescent.startMission(id), missionId);
    if (!started) fail(`startMission(${missionId}) returned false`);
  }
}

// Take the shot at the best quality that fits the 200 KiB cap.
async function takeShot(page, file) {
  mkdirSync(join(REPO, 'screenshots'), { recursive: true });
  const path = join(REPO, 'screenshots', file);
  for (const quality of [80, 70, 55]) {
    const buf = await page.screenshot({ type: 'jpeg', quality });
    if (buf.length <= 204800 || quality === 55) {
      writeFileSync(path, buf);
      return { file, bytes: buf.length, quality };
    }
  }
  return { file, bytes: 0, quality: 0 };
}

async function poseCover(page) {
  // m7 escape (wanted 3) near the waterfront road x=2600: the camera
  // then shows water at the right edge, patrol cars behind, minimap,
  // objective banner and stars all in frame.
  await startPlaying(page, 'm7');
  await waitFor(
    page,
    `() => window.__game && window.__game.mission.state === 'active' && window.__game.mission.stage === 1`,
    240000,
    'm7 escape stage',
  );
  await waitFor(
    page,
    `() => window.__game && window.__game.player.x > 2300 && !window.__game.player.onFoot && window.__game.stars >= 3`,
    180000,
    'player driving near the waterfront at 3 stars',
  );
  await sleep(1200);
}

async function poseMission(page) {
  // Probe 22 Nov 13:4x UTC: m8 finishes in ~24s and the whole on-foot
  // shootout lasts only ~4s (10–14s in), and the autopilot fights it
  // with an SMG picked up en route — pistol ammo NEVER drops below 48,
  // so an ammo-based condition can never fire and the mission is 'done'
  // long before a 240s wait ends. Wait only for the real engagement:
  // stage 0, on foot, nearest enemy within 350.
  await startPlaying(page, 'm8');
  await waitFor(
    page,
    `() => {
      const G = window.__game;
      if (!G || !G.mission || G.mission.state !== 'active' || G.mission.stage !== 0) return false;
      if (!G.player.onFoot) return false;
      if (!G.enemies || G.enemies.length === 0) return false;
      const d = Math.min(...G.enemies.map((e) => Math.hypot(e.x - G.player.x, e.y - G.player.y)));
      return d < 350;
    }`,
    240000,
    'm8 shootout engaged on foot (enemy near)',
  );
  await sleep(600);
}

async function poseNight(page) {
  // Night (hour 20), 4 stars, roadblock ahead: headlights, lamp pools
  // and the roadblock in one readable frame.
  await startPlaying(page, 'm7');
  await page.evaluate(() => {
    window.__game.time.t = 120;
  });
  await waitFor(
    page,
    `() => window.__game && window.__game.time.night > 0.9`,
    10000,
    'full night',
  );
  await page.evaluate(() => window.__crescent.addHeat(30));
  await waitFor(
    page,
    `() => {
      const G = window.__game;
      if (!G || G.stars < 4 || !G.player || G.player.onFoot) return false;
      const rbs = (G.police && G.police.roadblocks) || [];
      if (rbs.length === 0) return false;
      // A roadblock that merely exists is usually off-frame: wait until
      // one is close enough to the player to be visible in the shot.
      const d = Math.min(...rbs.map((rb) => Math.hypot(rb.x - G.player.x, rb.y - G.player.y)));
      if (d >= 450) return false;
      // And wait until the player is mid-block, not at a junction:
      // street-lamp pools sit at junctions, and a lamp pool stacked on
      // the headlights blows the player car out into one white bloom
      // (two full-run frames lost the player that way). Junctions are
      // at 200+i*400 on both axes.
      let jx = 1e9;
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          jx = Math.min(jx, Math.hypot(G.player.x - (200 + i * 400), G.player.y - (200 + j * 400)));
        }
      }
      return jx >= 120;
    }`,
    240000,
    '4 stars with a roadblock near the player while driving',
  );
  // Short settle: the roadblock is in frame now, do not drive past it.
  await sleep(800);
}

async function poseStart(page) {
  // Title overlay over the living city: traffic and pedestrians move
  // behind the panel for a few seconds before the shot.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
  await waitFor(page, `() => !!window.__game`, 10000, 'game state to exist');
  await sleep(4000);
}

const POSES = { cover: poseCover, mission: poseMission, night: poseNight, start: poseStart };

async function main() {
  const only = process.argv[2] || null;
  const wanted = only ? SHOTS.filter((s) => s.id === only) : SHOTS;
  if (only && wanted.length === 0) {
    console.log(`unknown shot ${only} (want one of ${SHOTS.map((s) => s.id).join(' ')})`);
    process.exit(2);
  }
  await startServer();
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--mute-audio'] });
  const results = [];
  let ok = true;
  try {
    for (const shot of wanted) {
      const { ctx, page, errors } = await freshPage(browser);
      try {
        console.log(`pose ${shot.id} ...`);
        await POSES[shot.id](page);
        const info = await takeShot(page, shot.file);
        if (errors.length > 0) {
          console.log(`  FAIL ${shot.id}: console errors: ${errors.join(' | ')}`);
          ok = false;
        } else {
          console.log(`  ${shot.file}: ${info.bytes} bytes (quality ${info.quality})`);
        }
        results.push({ ...info, errors });
      } catch (e) {
        console.log(`  FAIL ${shot.id}: ${(e && e.message) || e}`);
        results.push({ id: shot.id, file: shot.file, bytes: 0, quality: 0, errors: [String((e && e.message) || e)] });
        ok = false;
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    stopServer();
  }
  writeFileSync(join(REPO, 'tools', 'screenshots.json'), JSON.stringify({ at: new Date().toISOString(), shots: results }, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('screenshots crashed:', (e && e.message) || e);
  stopServer();
  process.exit(1);
});
