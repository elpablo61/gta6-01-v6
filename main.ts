// Crescent Bay entry program (Node 22, standard library only). The game is
// the static files under game/ plus the screenshots/ renders beside this
// file. This program hands the entry in: it copies game/ and screenshots/
// into the output folder and writes /output/dossier.json with the vendored
// make.fun library, then reports the dossier size so an oversize dossier is
// caught here instead of at the gate.
//
// Local run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Grader run: MAKEFUN_OUTPUT_DIR is /output already.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DOSSIER_WARN_BYTES = 1450000;
const SHOT_WARN_BYTES = 204800; // 200 KiB per screenshot, the entry's own target

// Walk a directory tree and total its files + bytes, so the entry's
// size is reported before the dossier is built (an oversize game or a
// single oversize screenshot is caught here, not at the gate).
function treeSize(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = treeSize(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

mkdirSync(outDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outDir, 'game'), { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
}

const dossierBytes = buildDossier(outDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(outDir, 'dossier.json'), dossierBytes);

const dossierSize = statSync(join(outDir, 'dossier.json')).size;
console.log(`dossier.json: ${dossierSize} bytes`);
if (dossierSize > DOSSIER_WARN_BYTES) {
  console.warn(`WARNING: dossier ${dossierSize} bytes is over the ${DOSSIER_WARN_BYTES} byte budget — shrink the screenshots first.`);
}

// Per-part report: game tree totals and each screenshot's size, so an
// oversize part is visible in the same log line run as the dossier.
const gameTotals = treeSize(join(outDir, 'game'));
console.log(`game/: ${gameTotals.files} files, ${gameTotals.bytes} bytes`);
for (const shot of readdirSync(join(outDir, 'screenshots'))) {
  const size = statSync(join(outDir, 'screenshots', shot)).size;
  console.log(`screenshots/${shot}: ${size} bytes`);
  if (size > SHOT_WARN_BYTES) {
    console.warn(`WARNING: screenshots/${shot} is ${size} bytes, over the ${SHOT_WARN_BYTES} byte target — lower the JPEG quality.`);
  }
}
