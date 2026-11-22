// radio.js — 3 procedural WebAudio radio stations. R cycles stations;
// the HUD (hud.js) shows the station name plus an animated equalizer.
// Station 1 ("Bay FM") is the default on New Game. The radio keeps
// playing through missions and free roam. Music only, no talk.
//
// AUDIO INTEGRATION (22 Nov, batch 2): audio.js (Builder A-2) owns the
// single AudioContext and music bus. When G.audio.engine is present
// (attached by audio.js's attachToGame), radio.js registers its three
// station patterns with engine.registerMusicPattern() and drives the bus
// with engine.setStation() / engine.startMusicLoop() / engine.stopMusic()
// — one audio source, no double music. When no engine is present (Node
// smoke tests, or audio.js not yet wired), radio.js falls back to its
// own AudioContext and its own richer step sequencer (kick, hats, pads,
// arps on top of the same bass lines), so the stations still play. The
// contract hook G.audio?.play('radioSwitch') is still called on every
// station change.
export const RADIO_STATIONS = [
  { id: 'bay', name: 'Bay FM', genre: 'synthwave', bpm: 100, desc: 'Driving bass synthwave' },
  { id: 'jazz', name: 'Harbor Jazz', genre: 'swing', bpm: 84, desc: 'Slow swing jazz' },
  { id: 'rock', name: 'Crescent Rock', genre: 'rock', bpm: 132, desc: 'Driving rock riff' },
];

// Bass-line patterns for audio.js's music bus: one MIDI note per 8th
// step, 0 = rest. Same musical identity as the fallback sequencer below.
export const RADIO_PATTERNS = [
  { bpm: 100, wave: 'sawtooth', bass: [33, 0, 33, 33, 29, 0, 29, 29, 36, 0, 36, 36, 31, 0, 31, 31] },
  { bpm: 84, wave: 'triangle', bass: [36, 0, 38, 0, 33, 0, 35, 0, 38, 0, 40, 0, 31, 0, 33, 0] },
  { bpm: 132, wave: 'square', bass: [40, 40, 43, 45, 40, 40, 47, 45, 40, 40, 43, 45, 47, 45, 43, 40] },
];

export const RADIO_MASTER_GAIN = 0.16;
export const RADIO_SCHEDULE_AHEAD_SECONDS = 0.15;
export const RADIO_TIMER_MS = 40;

export function createRadioState() {
  return {
    station: 0, started: false, nodes: null,
    eqLevel: 0, prevR: false, badgeEl: null,
    step: 0, nextTime: 0, timer: null, ctx: null,
    engineMode: false, patternsRegistered: false,
  };
}

export function ensureRadioState(G) {
  if (!G.radio) G.radio = createRadioState();
  if (typeof G.radio.station !== 'number') G.radio.station = 0;
  if (typeof G.radio.started !== 'boolean') G.radio.started = false;
  if (typeof G.radio.eqLevel !== 'number') G.radio.eqLevel = 0;
  if (typeof G.radio.step !== 'number') G.radio.step = 0;
  return G.radio;
}

export function currentStation(G) {
  ensureRadioState(G);
  return RADIO_STATIONS[((G.radio.station % RADIO_STATIONS.length) + RADIO_STATIONS.length) % RADIO_STATIONS.length];
}

export function currentStationName(G) {
  return currentStation(G).name;
}

function hasDocument() {
  return typeof document !== 'undefined' && document && typeof document.createElement === 'function';
}

function hasAudioContext() {
  return typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
}

// Small DOM badge showing the current station name, so a scripted check
// can cycle all three stations and assert the displayed name changes
// (hud.js also draws the name on canvas). Created lazily, never throws.
function ensureStationBadge(G) {
  ensureRadioState(G);
  if (!hasDocument()) return null;
  if (G.radio.badgeEl && G.radio.badgeEl.isConnected) return G.radio.badgeEl;
  const el = document.createElement('div');
  el.id = 'radio-station';
  el.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);'
    + 'background:rgba(16,18,28,0.8);color:#ffd76a;border:1px solid #ffd76a;border-radius:6px;'
    + 'padding:4px 12px;font: bold 14px sans-serif;z-index:30;pointer-events:none;';
  document.body.appendChild(el);
  G.radio.badgeEl = el;
  updateStationBadge(G);
  return el;
}

function updateStationBadge(G) {
  ensureRadioState(G);
  if (G.radio.badgeEl) G.radio.badgeEl.textContent = '♪ ' + currentStationName(G);
}

export function attachRadioContext(G, ctx) {
  ensureRadioState(G);
  if (!ctx) return false;
  G.radio.ctx = ctx;
  return true;
}

// The audio.js engine, when attached to G (G.audio.engine with
// registerMusicPattern / startMusicLoop). Null when audio.js is not
// wired yet — radio.js then uses its own AudioContext (fallback).
export function audioEngine(G) {
  const a = G && G.audio;
  if (a && a.engine && typeof a.engine.registerMusicPattern === 'function'
    && typeof a.engine.startMusicLoop === 'function') {
    return a.engine;
  }
  return null;
}

export function registerRadioPatterns(G) {
  ensureRadioState(G);
  const engine = audioEngine(G);
  if (!engine) return false;
  for (let i = 0; i < RADIO_PATTERNS.length; i++) {
    engine.registerMusicPattern(i, RADIO_PATTERNS[i]);
  }
  G.radio.patternsRegistered = true;
  return true;
}

function getAudioContext(G) {
  ensureRadioState(G);
  if (G.radio.ctx) return G.radio.ctx;
  if (!hasAudioContext()) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  try {
    const ctx = new AC();
    G.radio.ctx = ctx;
    return ctx;
  } catch (e) {
    return null;
  }
}

function ensureNodes(G) {
  ensureRadioState(G);
  const ctx = getAudioContext(G);
  if (!ctx) return null;
  if (G.radio.nodes && G.radio.nodes.ctx === ctx) return G.radio.nodes;
  const master = ctx.createGain();
  master.gain.value = RADIO_MASTER_GAIN;
  master.connect(ctx.destination);
  // One shared noise buffer for hats / snares / ride ticks.
  const len = ctx.sampleRate * 0.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  G.radio.nodes = { ctx, master, noiseBuf: buf };
  return G.radio.nodes;
}

// One synth note: oscillator -> gain envelope -> optional lowpass -> master.
function tone(G, freq, time, dur, type, vol, filterFreq) {
  const nodes = G.radio.nodes;
  if (!nodes) return;
  const ctx = nodes.ctx;
  const osc = ctx.createOscillator();
  osc.type = type || 'sawtooth';
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(vol, time + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  let head = osc;
  if (filterFreq) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = filterFreq;
    osc.connect(filt);
    head = filt;
  }
  head.connect(gain);
  gain.connect(nodes.master);
  osc.start(time);
  osc.stop(time + dur + 0.05);
}

function noiseHit(G, time, dur, vol, filterFreq, filterType) {
  const nodes = G.radio.nodes;
  if (!nodes) return;
  const ctx = nodes.ctx;
  const src = ctx.createBufferSource();
  src.buffer = nodes.noiseBuf;
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = filterType || 'highpass';
  filt.frequency.value = filterFreq || 6000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  src.connect(filt);
  filt.connect(gain);
  gain.connect(nodes.master);
  src.start(time);
  src.stop(time + dur + 0.05);
}

// Chord progressions as root frequencies (Hz). Bars are 16 steps.
const BAY_ROOTS = [55.0, 43.65, 65.41, 49.0]; // A1 F1 C2 G1
const BAY_CHORDS = [
  [220.0, 261.63, 329.63], [174.61, 220.0, 261.63],
  [261.63, 329.63, 392.0], [196.0, 246.94, 293.66],
];
const BAY_ARP = [440.0, 523.25, 659.25, 523.25, 440.0, 329.63, 392.0, 523.25];

const JAZZ_ROOTS = [65.41, 55.0, 73.42, 49.0]; // C2 A1 D2 G1
const JAZZ_CHORDS = [
  [261.63, 329.63, 493.88], [220.0, 261.63, 329.63],
  [293.66, 349.23, 440.0], [196.0, 246.94, 293.66],
];

const ROCK_RIFF = [82.41, 82.41, 98.0, 110.0, 82.41, 82.41, 123.47, 110.0]; // E E G A E E B A
const ROCK_CHORDS = [82.41, 98.0, 110.0, 123.47];

// One 16th-note step of the current station's loop.
function scheduleStep(G, stationIdx, step, time) {
  const station = RADIO_STATIONS[stationIdx];
  const bar = Math.floor(step / 16) % 4;
  const s16 = step % 16;
  if (station.id === 'bay') {
    // Synthwave: driving 8th-note bass, kick on quarters, hats off-beat,
    // pad chord at the bar start, quiet arp on top.
    if (s16 % 2 === 0) tone(G, BAY_ROOTS[bar] * 2, time, 0.22, 'sawtooth', 0.5, 900);
    if (s16 % 4 === 0) tone(G, 60, time, 0.12, 'sine', 0.9);
    if (s16 % 2 === 1) noiseHit(G, time, 0.04, 0.12, 8000);
    if (s16 === 0) {
      for (const f of BAY_CHORDS[bar]) tone(G, f, time, 1.8, 'sawtooth', 0.10, 1400);
    }
    tone(G, BAY_ARP[s16 % BAY_ARP.length], time, 0.14, 'square', 0.06, 2400);
  } else if (station.id === 'jazz') {
    // Slow swing: walking bass on quarters (swung), ride tick every step,
    // chord stab on 0 and 8, soft melody note on 12.
    const swing = s16 % 2 === 1 ? 0.03 : 0;
    const t = time + swing;
    if (s16 % 4 === 0) tone(G, JAZZ_ROOTS[bar], t, 0.4, 'triangle', 0.55);
    noiseHit(G, t, 0.03, s16 % 4 === 0 ? 0.16 : 0.07, 9000);
    if (s16 === 0 || s16 === 8) {
      for (const f of JAZZ_CHORDS[bar]) tone(G, f, t, 0.7, 'sine', 0.12);
    }
    if (s16 === 12) tone(G, JAZZ_CHORDS[bar][1] * 2, t, 0.5, 'sine', 0.10);
  } else {
    // Crescent Rock: driving riff — kick on quarters + 14, snare on 4/12,
    // power-chord stabs on the riff steps, bass doubling the riff.
    if (s16 % 4 === 0 || s16 === 14) tone(G, 70, time, 0.1, 'sine', 0.85);
    if (s16 === 4 || s16 === 12) noiseHit(G, time, 0.14, 0.4, 1800, 'bandpass');
    if (s16 % 2 === 0) noiseHit(G, time, 0.03, 0.10, 8000);
    const riffStep = [0, 3, 6, 8, 11, 14].includes(s16);
    if (riffStep) {
      const f = ROCK_RIFF[s16 % ROCK_RIFF.length];
      tone(G, f * 2, time, 0.18, 'sawtooth', 0.30, 1800);
      tone(G, f * 3, time, 0.18, 'sawtooth', 0.14, 1800);
      tone(G, f, time, 0.2, 'square', 0.35, 700);
    }
    if (s16 === 0) tone(G, ROCK_CHORDS[bar], time, 0.4, 'sawtooth', 0.12, 1200);
  }
}

function scheduleAhead(G) {
  ensureRadioState(G);
  const nodes = G.radio.nodes;
  if (!nodes || !G.radio.started) return;
  const ctx = nodes.ctx;
  const station = currentStation(G);
  const stepDur = 60 / station.bpm / 4;
  while (G.radio.nextTime < ctx.currentTime + RADIO_SCHEDULE_AHEAD_SECONDS) {
    scheduleStep(G, G.radio.station, G.radio.step, G.radio.nextTime);
    G.radio.nextTime += stepDur;
    G.radio.step = (G.radio.step + 1) % 64;
  }
}

export function startRadio(G) {
  ensureRadioState(G);
  if (G.radio.started) return true;
  // Preferred path: the audio.js engine owns the one AudioContext.
  const engine = audioEngine(G);
  if (engine) {
    if (!G.radio.patternsRegistered) registerRadioPatterns(G);
    engine.setStation(G.radio.station);
    engine.startMusicLoop();
    G.radio.engineMode = true;
    G.radio.started = true;
    ensureStationBadge(G);
    return true;
  }
  // Fallback path: no engine — own AudioContext + own step sequencer.
  G.radio.engineMode = false;
  const nodes = ensureNodes(G);
  if (!nodes) return false; // No AudioContext yet (no gesture / headless).
  const ctx = nodes.ctx;
  if (ctx.state === 'suspended') {
    try { ctx.resume(); } catch (e) { /* resume on next gesture */ }
  }
  G.radio.nextTime = ctx.currentTime + 0.08;
  G.radio.step = 0;
  if (typeof setInterval === 'function') {
    G.radio.timer = setInterval(() => scheduleAhead(G), RADIO_TIMER_MS);
  }
  G.radio.started = true;
  ensureStationBadge(G);
  return true;
}

export function stopRadio(G) {
  ensureRadioState(G);
  if (G.radio.engineMode) {
    const engine = audioEngine(G);
    if (engine && typeof engine.stopMusic === 'function') engine.stopMusic();
    G.radio.started = false;
    return true;
  }
  if (G.radio.timer !== null && typeof clearInterval === 'function') {
    clearInterval(G.radio.timer);
  }
  G.radio.timer = null;
  G.radio.started = false;
  if (G.radio.nodes && G.radio.nodes.ctx) {
    try { G.radio.nodes.ctx.suspend(); } catch (e) { /* ignore */ }
  }
  return true;
}

export function setStation(G, index) {
  ensureRadioState(G);
  const n = RADIO_STATIONS.length;
  const next = ((index % n) + n) % n;
  const changed = next !== G.radio.station;
  G.radio.station = next;
  // Restart the pattern from the top of the loop so the new station is
  // audible immediately instead of mid-bar.
  G.radio.step = 0;
  if (G.radio.started && G.radio.engineMode) {
    const engine = audioEngine(G);
    if (engine) {
      // Restart the bus so the new station's tempo takes effect.
      if (typeof engine.stopMusic === 'function') engine.stopMusic();
      engine.setStation(next);
      engine.startMusicLoop();
    }
  } else if (G.radio.started && G.radio.nodes) {
    G.radio.nextTime = G.radio.nodes.ctx.currentTime + 0.05;
  }
  updateStationBadge(G);
  if (changed && G.audio) G.audio.play && G.audio.play('radioSwitch');
  return currentStationName(G);
}

export function cycleStation(G) {
  ensureRadioState(G);
  return setStation(G, G.radio.station + 1);
}

function keyDown(G, codes) {
  if (!G.input || !G.input.keys) return false;
  for (const c of codes) if (G.input.keys.has(c)) return true;
  return false;
}

// Called every frame while playing. R cycles stations; the radio starts
// itself on the first playing frame that can create an AudioContext
// (after the player's first gesture — never before, so it cannot throw
// an autoplay error). The equalizer level animates for the HUD.
export function updateRadio(G, dt) {
  ensureRadioState(G);
  const down = keyDown(G, ['KeyR', 'r', 'R']);
  const edge = down && !G.radio.prevR;
  G.radio.prevR = down;
  if (edge) cycleStation(G);
  if (!G.radio.started && G.state === 'playing') {
    startRadio(G);
  }
  const t = (G.time && G.time.t) || 0;
  const beat = Math.abs(Math.sin(t * (2 + G.radio.station) + G.radio.station * 1.7));
  G.radio.eqLevel = G.radio.started ? 0.25 + 0.75 * beat : 0;
}
