// world.js — Crescent Bay city generation: districts, road graph,
// BFS route finder, collision queries. The whole city is deterministic
// from the seeded RNG, so a fixed seed always builds the same world.
//
// Junction indexing (the v1 infinite-loop bug): a junction is indexed
// CONSISTENTLY as idx = row * 8 + col, where col is the x-road index
// and row is the y-road index. Every helper in this file uses that one
// convention; the BFS parent chain can never cycle on a transposition.

import {
  WORLD_SIZE, ROADS, ROAD_WIDTH, DISTRICTS, LANDMARKS,
  WATER_X, BEACH_X, SPRAY_SHOP_RADIUS,
} from './config.js';

// Create the whole city from a seeded RNG. Returns the world object
// that main.js hands to G as G.world.
export function createWorld(rng) {
  const rand = rng || Math.random;
  const world = {
    size: WORLD_SIZE,
    roads: ROADS.slice(),
    roadWidth: ROAD_WIDTH,
    buildings: [],
    parks: [],
    lamps: [],
    trees: [],
    districts: DISTRICTS,
    // Named places (all on road intersections so cars can drive to them).
    hideout: { ...LANDMARKS.hideout },
    market: { ...LANDMARKS.market },
    downtown: { ...LANDMARKS.downtown },
    club: { ...LANDMARKS.club },
    marina: { ...LANDMARKS.marina },
    docks: { ...LANDMARKS.docks },
    airport: { ...LANDMARKS.airport },
    bank: { ...LANDMARKS.bank },
    gunStore: { ...LANDMARKS.gunStore },
    garage: { x: LANDMARKS.garage.x, y: LANDMARKS.garage.y, r: 90 },
    sprayShop: { x: LANDMARKS.sprayShop.x, y: LANDMARKS.sprayShop.y, r: SPRAY_SHOP_RADIUS },
    waterX: WATER_X,
    beachX: BEACH_X,
  };

  generateBuildings(world, rand);
  generateParks(world, rand);
  generateLamps(world);

  // Route finder, collision and road helpers are bound to this world.
  world.findRoute = (x1, y1, x2, y2) => findRoute(world, x1, y1, x2, y2);
  world.nearestRoadPoint = (x, y) => nearestRoadPoint(x, y);
  world.nearestJunction = (x, y) => nearestJunction(x, y);
  world.isBlockedAt = (x, y, r) => isBlockedAt(world, x, y, r || 0);
  world.isOnRoad = (x, y, tol) => isOnRoad(x, y, tol);
  world.districtAt = (x, y) => districtAt(world, x, y);
  world.randomJunction = () => randomJunction(rand);
  world.randomRoadPoint = () => randomRoadPoint(rand);
  return world;
}

// Which district covers a point. First match wins; the districts tile
// the map with the waterfront strip on the east and the docks south.
export function districtAt(world, x, y) {
  const list = Object.values(world.districts || DISTRICTS);
  for (const d of list) {
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return d;
  }
  return list[0];
}

// --- buildings -------------------------------------------------------------

// Building palettes per district flavour. Roof colour is always a
// shade off the walls so the 2.5D roof reads at a glance.
const PALETTES = {
  houses: {
    walls: ['#e8c9a0', '#dfb28a', '#d9a06f', '#cdb28a', '#e0bfae', '#cfa87e'],
    roofs: ['#a8543c', '#8f4a34', '#7a5a3a', '#96502f'],
  },
  brick: {
    walls: ['#9a5b43', '#8a4f3a', '#a5684a', '#7d4632', '#96604a'],
    roofs: ['#5c3a2c', '#4e3226', '#6b4536'],
  },
  glass: {
    walls: ['#7fa8c9', '#6b9bbf', '#8fb4d4', '#5f8fb5', '#a8c4d8'],
    roofs: ['#3d5a74', '#334e66', '#47657f'],
  },
  sand: {
    walls: ['#e8d5a8', '#dfc795', '#e0cfa8', '#d5bd8a'],
    roofs: ['#b98a4a', '#a87a3e', '#c49a58'],
  },
  industrial: {
    walls: ['#8a8d90', '#7a7d80', '#96999c', '#6f7275', '#a8a49a'],
    roofs: ['#4a4d4f', '#3f4244', '#55585a'],
  },
};

function generateBuildings(world, rand) {
  // Blocks sit between neighbouring roads: block (i, j) spans
  // x in [ROADS[i]+48, ROADS[i+1]-48], y in [ROADS[j]+48, ROADS[j+1]-48].
  // The strip east of road 3000 is beach + water: no buildings there.
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const x0 = ROADS[i] + 48;
      const x1 = ROADS[i + 1] - 48;
      const y0 = ROADS[j] + 48;
      const y1 = ROADS[j + 1] - 48;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const district = districtAt(world, cx, cy);
      const flavour = district.flavour;
      // Waterfront blocks are mostly open sand; the docks get big sheds.
      if (flavour === 'sand' && rand() < 0.55) continue;
      let count = 2;
      if (flavour === 'glass') count = rand() < 0.5 ? 1 : 2;
      else if (flavour === 'industrial') count = rand() < 0.5 ? 1 : 2;
      else count = 2 + (rand() < 0.5 ? 1 : 0);
      // Split the block into a 2x2 grid of cells and put at most one
      // building in each chosen cell, so buildings never overlap.
      const cells = shuffle4(rand);
      const pal = PALETTES[flavour] || PALETTES.houses;
      for (let k = 0; k < count && k < 4; k++) {
        const cell = cells[k];
        const cellX = cell % 2;
        const cellY = Math.floor(cell / 2);
        const cw = (x1 - x0) / 2;
        const ch = (y1 - y0) / 2;
        const bx = x0 + cellX * cw;
        const by = y0 + cellY * ch;
        const bw = flavour === 'glass'
          ? 120 + rand() * 90
          : 80 + rand() * 110;
        const bh = flavour === 'glass'
          ? 120 + rand() * 90
          : 60 + rand() * 90;
        const w = Math.min(bw, cw - 24);
        const h = Math.min(bh, ch - 24);
        if (w < 40 || h < 40) continue;
        const x = bx + (cw - w) / 2 + (rand() - 0.5) * 16;
        const y = by + (ch - h) / 2 + (rand() - 0.5) * 16;
        const wall = pal.walls[Math.floor(rand() * pal.walls.length)];
        const roof = pal.roofs[Math.floor(rand() * pal.roofs.length)];
        const hgt = flavour === 'glass'
          ? 42 + rand() * 48
          : flavour === 'industrial'
            ? 18 + rand() * 14
            : 12 + rand() * 18;
        world.buildings.push({
          x, y, w, h, hgt, wall, roof, district: district.id, flavour,
        });
      }
    }
  }
}

// A shuffled [0, 1, 2, 3] for the block-cell placement above.
function shuffle4(rand) {
  const a = [0, 1, 2, 3];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function generateParks(world, rand) {
  // A handful of blocks become parks: green ground with trees. Parks
  // are walkable and never contain buildings (their blocks are skipped
  // by the tree pass only — buildings were already placed, so parks are
  // chosen from blocks with at most one building and the park is drawn
  // in the open corner of the block).
  const parkBlocks = [];
  while (parkBlocks.length < 7) {
    const i = Math.floor(rand() * 7);
    const j = Math.floor(rand() * 7);
    const key = `${i},${j}`;
    if (parkBlocks.includes(key)) continue;
    parkBlocks.push(key);
    const x0 = ROADS[i] + 48;
    const y0 = ROADS[j] + 48;
    const w = ROADS[i + 1] - ROADS[i] - 96;
    const h = ROADS[j + 1] - ROADS[j] - 96;
    const park = { x: x0, y: y0, w, h, trees: [] };
    const treeCount = 4 + Math.floor(rand() * 4);
    for (let t = 0; t < treeCount; t++) {
      park.trees.push({
        x: x0 + 30 + rand() * (w - 60),
        y: y0 + 30 + rand() * (h - 60),
        r: 12 + rand() * 10,
      });
    }
    world.parks.push(park);
    world.trees.push(...park.trees);
  }
}

function generateLamps(world) {
  // One street lamp at every junction, offset south-east of the corner,
  // so night light pools land on the roads.
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      world.lamps.push({ x: ROADS[i] + 46, y: ROADS[j] + 46 });
    }
  }
}

// --- road graph ------------------------------------------------------------

// Nearest road coordinate on each axis (roads are at 200 + i*400).
function nearestRoadCoord(v) {
  let best = ROADS[0];
  for (const r of ROADS) {
    if (Math.abs(r - v) < Math.abs(best - v)) best = r;
  }
  return best;
}

// Nearest junction (a real road crossing) to a point.
export function nearestJunction(x, y) {
  return { x: nearestRoadCoord(x), y: nearestRoadCoord(y) };
}

// Nearest point on any road centreline to (x, y): pick the closer of
// the vertical-road point and the horizontal-road point. The result is
// always ON a road, never a centreline point outside the world edge.
export function nearestRoadPoint(x, y) {
  const bx = nearestRoadCoord(x);
  const by = nearestRoadCoord(y);
  return Math.abs(bx - x) < Math.abs(by - y) ? { x: bx, y } : { x, y: by };
}

// Is a point on a road (within tol of a centreline)?
export function isOnRoad(x, y, tol) {
  const t = typeof tol === 'number' ? tol : 42;
  const bx = nearestRoadCoord(x);
  const by = nearestRoadCoord(y);
  return Math.abs(bx - x) <= t || Math.abs(by - y) <= t;
}

// Junction index, ONE convention everywhere: idx = row * 8 + col,
// col = x-road index, row = y-road index.
function junctionIndex(col, row) {
  return row * 8 + col;
}

function junctionFromIndex(idx) {
  const row = Math.floor(idx / 8);
  const col = idx % 8;
  return { x: ROADS[col], y: ROADS[row] };
}

function junctionIndicesFor(x, y) {
  const j = nearestJunction(x, y);
  return { col: ROADS.indexOf(j.x), row: ROADS.indexOf(j.y) };
}

// BFS route finder on the 8x8 junction graph. The route ALWAYS starts
// with the FIRST junction (nearest the start point) so a car never cuts
// diagonally across a block, then walks Manhattan along junctions, then
// ends on the exact target point.
export function findRoute(world, x1, y1, x2, y2) {
  const s = junctionIndicesFor(x1, y1);
  const e = junctionIndicesFor(x2, y2);
  const start = junctionIndex(s.col, s.row);
  const goal = junctionIndex(e.col, e.row);
  if (start === goal) {
    return [{ x: ROADS[s.col], y: ROADS[s.row] }, { x: x2, y: y2 }];
  }
  // BFS with a visited set and a parent map. The queue is bounded by
  // the 64 junctions, so this can never loop forever.
  const prev = new Array(64).fill(-1);
  const seen = new Array(64).fill(false);
  const queue = [start];
  seen[start] = true;
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === goal) break;
    const row = Math.floor(cur / 8);
    const col = cur % 8;
    const neighbours = [];
    if (col > 0) neighbours.push(junctionIndex(col - 1, row));
    if (col < 7) neighbours.push(junctionIndex(col + 1, row));
    if (row > 0) neighbours.push(junctionIndex(col, row - 1));
    if (row < 7) neighbours.push(junctionIndex(col, row + 1));
    for (const n of neighbours) {
      if (!seen[n]) {
        seen[n] = true;
        prev[n] = cur;
        queue.push(n);
      }
    }
  }
  if (!seen[goal]) return null;
  // Walk the parent chain back from the goal to the start.
  const chain = [];
  let cur = goal;
  let guard = 0;
  while (cur !== -1 && guard < 70) {
    chain.push(cur);
    if (cur === start) break;
    cur = prev[cur];
    guard++;
  }
  chain.reverse();
  const pts = chain.map((idx) => junctionFromIndex(idx));
  pts.push({ x: x2, y: y2 });
  return pts;
}

// --- collision -------------------------------------------------------------

// Is the point (x, y) blocked — inside a building, in deep water, or
// outside the world? r inflates every obstacle by the caller's radius
// (car half-width, player radius) so entities slide instead of clipping.
export function isBlockedAt(world, x, y, r) {
  const rad = r || 0;
  if (x < 6 + rad || x > WORLD_SIZE - 6 - rad) return true;
  if (y < 6 + rad || y > WORLD_SIZE - 6 - rad) return true;
  // Deep water east of the beach: the sand strip itself is walkable.
  if (x > 3110 + rad) return true;
  for (const b of world.buildings) {
    if (
      x > b.x - rad && x < b.x + b.w + rad &&
      y > b.y - rad && y < b.y + b.h + rad
    ) {
      return true;
    }
  }
  return false;
}

// --- random spawn helpers --------------------------------------------------

function randomJunction(rand) {
  const i = Math.floor(rand() * 8);
  const j = Math.floor(rand() * 8);
  return { x: ROADS[i], y: ROADS[j] };
}

function randomRoadPoint(rand) {
  const horizontal = rand() < 0.5;
  const road = ROADS[Math.floor(rand() * 8)];
  const along = 60 + rand() * (WORLD_SIZE - 120);
  return horizontal ? { x: along, y: road } : { x: road, y: along };
}
