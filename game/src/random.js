// random.js — deterministic RNG for Crescent Bay (mulberry32, seed
// 20261118 from the spec). The whole city, traffic and pedestrian layout
// is generated from this one seeded stream so a fixed seed always builds
// the same world and the screenshot poses are reproducible.

// mulberry32: a small, fast, well-behaved 32-bit seeded generator.
// Returns a function that yields a float in [0, 1) on every call.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Create a fresh RNG bound to a seed. Default is the game's world seed.
export function createRng(seed = 20261118) {
  return mulberry32(seed);
}

// The shared world RNG. main.js hands this to G as G.rng; every module
// that needs a random number draws from it so the stream stays in one
// deterministic order.
export const worldRng = mulberry32(20261118);

// Helpers that draw from any rng function in [0, 1).

// Integer in [min, max] inclusive.
export function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

// Float in [min, max).
export function randomRange(rng, min, max) {
  return min + rng() * (max - min);
}

// Pick one element of an array.
export function randomPick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

// Fisher-Yates shuffle that returns a new array, leaving the input alone.
export function shuffle(rng, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
