// One-off C-3 debug probe: watch m8 unfold, sample every 2s.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REPO = '/home/hatch/workspace/makefun-sweep/gta6-01-v6';
const EXECUTABLE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell');
const PORT = 8933;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverProc = spawn('node', ['serve.ts', '--port', String(PORT)], { cwd: REPO });
await sleep(1500);
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#title-screen:visible', { timeout: 10000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 10000 });
await page.click('#new-game-btn');
await page.waitForFunction(() => window.__game && window.__game.state === 'playing', null, { timeout: 5000 });
await page.evaluate(() => window.__game.systems.autopilot.enableAutopilot(window.__game));
const started = await page.evaluate(() => window.__crescent.startMission('m8'));
console.log('startMission m8:', started);
const COND = `() => {
      const G = window.__game;
      if (!G || !G.mission || G.mission.state !== 'active' || G.mission.stage !== 0) return false;
      if (!G.player.onFoot) return false;
      if (!G.enemies || G.enemies.length === 0) return false;
      const d = Math.min(...G.enemies.map((e) => Math.hypot(e.x - G.player.x, e.y - G.player.y)));
      return d < 350;
    }`;
const t0 = Date.now();
let condTrueAt = null;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const s = await page.evaluate((condSrc) => {
    const G = window.__game;
    if (!G) return { ready: false };
    let cond = 'err';
    try { cond = eval('(' + condSrc + ')()'); } catch (e) { cond = 'throw:' + e.message; }
    const es = (G.enemies || []).map((e) => Math.round(Math.hypot(e.x - G.player.x, e.y - G.player.y)));
    return {
      state: G.state, mstate: G.mission && G.mission.state, stage: G.mission && G.mission.stage,
      dialog: !!(G.mission && G.mission.dialogOpen), onFoot: G.player.onFoot,
      px: Math.round(G.player.x), py: Math.round(G.player.y),
      hp: Math.round(G.player.hp ?? -1), ammoP: G.weapons && G.weapons.ammo ? G.weapons.ammo.pistol : null,
      ammoCur: G.weapons ? G.weapons.current : null,
      nEnemies: (G.enemies || []).length, enemyDist: es.length ? Math.min(...es) : null,
      timeLeft: G.mission ? Math.round(G.mission.timeLeft) : null,
      speed: Math.round(G.player.speed || 0), stars: G.stars,
      gameT: G.time ? Math.round(G.time.t * 10) / 10 : null, cond,
    };
  }, COND);
  if (s.cond === true && condTrueAt === null) condTrueAt = ((Date.now() - t0) / 1000).toFixed(0) + 's';
  console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(s));
  if (s.mstate === 'done' || s.mstate === 'failed') break;
}
console.log('condition first true at wall:', condTrueAt);
console.log('errors:', JSON.stringify(errors));
await browser.close();
serverProc.kill('SIGTERM');
process.exit(0);
