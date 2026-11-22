// audio.js — WebAudio synth engine for Crescent Bay. No audio files,
// no network: every sound is synthesized. The engine is a no-op stub
// when there is no AudioContext (Node smoke tests, or before the first
// user gesture), so calling play() can never throw.
//
// First declarations are the named SFX entry points the outline shows:
// playSiren, playGunshot, startMusicLoop. The radio stations themselves
// (Bay FM / Harbor Jazz / Crescent Rock) live in radio.js, which calls
// this engine through setStation / registerMusicPattern — no station
// melodies are written here.

// Start (or keep) the two-tone police siren loop.
export function playSiren(engine) {
  if (engine) engine.startSiren();
  return engine;
}

// One pistol gunshot: sharp noise crack plus a low thump.
export function playGunshot(engine) {
  if (engine) engine.play('gunshot');
  return engine;
}

// Start the music bus (the current radio station's loop, if any pattern
// has been registered; otherwise a plain neutral pulse until radio.js
// registers the station patterns).
export function startMusicLoop(engine) {
  if (engine) engine.startMusicLoop();
  return engine;
}

export function stopMusicLoop(engine) {
  if (engine) engine.stopMusic();
  return engine;
}

// Switch the radio station on the music bus (radio.js owns the patterns).
export function setRadioStation(engine, index) {
  if (engine) engine.setStation(index);
  return engine;
}

// --- engine ---------------------------------------------------------------

// MIDI note number to frequency.
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function createAudioEngine() {
  const engine = {
    ctx: null,
    master: null,
    sfxGain: null,
    musicGain: null,
    muted: false,
    started: false,
    station: 0,
    stationPatterns: [],
    _sirenNodes: null,
    _heliNodes: null,
    _musicTimer: null,
    _musicStep: 0,
    _noiseBuffer: null,
  };

  // Create the AudioContext lazily, on first real use (which happens
  // after a user gesture, so autoplay rules are satisfied). Returns null
  // outside a browser or when audio is unavailable.
  function ensureContext() {
    if (engine.ctx) return engine.ctx;
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = engine.muted ? 0 : 0.9;
      master.connect(ctx.destination);
      const sfxGain = ctx.createGain();
      sfxGain.gain.value = 0.9;
      sfxGain.connect(master);
      const musicGain = ctx.createGain();
      musicGain.gain.value = 0.35;
      musicGain.connect(master);
      engine.ctx = ctx;
      engine.master = master;
      engine.sfxGain = sfxGain;
      engine.musicGain = musicGain;
      // One second of white noise, reused by every noise-based SFX.
      const len = ctx.sampleRate;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      engine._noiseBuffer = buf;
      return ctx;
    } catch (err) {
      return null;
    }
  }

  function noiseSource(ctx, duration) {
    const src = ctx.createBufferSource();
    src.buffer = engine._noiseBuffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = duration;
    return src;
  }

  // Short oscillator blip with an exponential decay envelope.
  function blip(opts) {
    const ctx = ensureContext();
    if (!ctx) return;
    const {
      type = 'sine', from = 440, to = null, duration = 0.15,
      volume = 0.5, delay = 0, bus = null,
    } = opts;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain);
    gain.connect(bus || engine.sfxGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // Filtered noise burst (gunshots, crashes, impacts).
  function noiseBurst(opts) {
    const ctx = ensureContext();
    if (!ctx) return;
    const {
      duration = 0.15, volume = 0.6, filterFreq = 3000,
      filterType = 'lowpass', delay = 0,
    } = opts;
    const t0 = ctx.currentTime + delay;
    const src = noiseSource(ctx, duration);
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(engine.sfxGain);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  // --- one-shot SFX (each is a small synth recipe) ------------------------

  function sfxGunshot() {
    noiseBurst({ duration: 0.09, volume: 0.7, filterFreq: 4500, filterType: 'highpass' });
    blip({ type: 'sine', from: 180, to: 55, duration: 0.12, volume: 0.5 });
  }

  function sfxEnemyShot() {
    noiseBurst({ duration: 0.08, volume: 0.35, filterFreq: 3200, filterType: 'highpass' });
    blip({ type: 'sine', from: 150, to: 50, duration: 0.1, volume: 0.25 });
  }

  function sfxHit() {
    blip({ type: 'square', from: 220, to: 110, duration: 0.07, volume: 0.3 });
  }

  function sfxPickup() {
    blip({ type: 'sine', from: 660, to: 660, duration: 0.08, volume: 0.4 });
    blip({ type: 'sine', from: 880, to: 880, duration: 0.12, volume: 0.4, delay: 0.07 });
  }

  function sfxCrash() {
    noiseBurst({ duration: 0.3, volume: 0.7, filterFreq: 900 });
    blip({ type: 'sine', from: 120, to: 35, duration: 0.35, volume: 0.6 });
  }

  function sfxWeaponSwitch() {
    blip({ type: 'square', from: 1200, to: 900, duration: 0.03, volume: 0.2 });
  }

  function sfxHeliHit() {
    blip({ type: 'square', from: 320, to: 180, duration: 0.15, volume: 0.4 });
    noiseBurst({ duration: 0.12, volume: 0.4, filterFreq: 2500, filterType: 'bandpass' });
  }

  function sfxUiClick() {
    blip({ type: 'sine', from: 520, to: 520, duration: 0.05, volume: 0.3 });
  }

  function sfxEngineStart() {
    blip({ type: 'sawtooth', from: 60, to: 140, duration: 0.4, volume: 0.25 });
  }

  // --- looping SFX ---------------------------------------------------------

  engine.startSiren = function startSiren() {
    const ctx = ensureContext();
    if (!ctx || engine._sirenNodes) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 800;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 0.55;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(engine.sfxGain);
    osc.start();
    lfo.start();
    engine._sirenNodes = { osc, lfo, gain };
  };

  engine.stopSiren = function stopSiren() {
    const ctx = engine.ctx;
    if (!ctx || !engine._sirenNodes) return;
    const { osc, lfo, gain } = engine._sirenNodes;
    try {
      gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.15);
      osc.stop(ctx.currentTime + 0.2);
      lfo.stop(ctx.currentTime + 0.2);
    } catch (err) { /* already stopped */ }
    engine._sirenNodes = null;
  };

  engine.startHeliLoop = function startHeliLoop() {
    const ctx = ensureContext();
    if (!ctx || engine._heliNodes) return;
    const src = noiseSource(ctx, 1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.4);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(engine.sfxGain);
    src.start();
    lfo.start();
    engine._heliNodes = { src, lfo, gain };
  };

  engine.stopHeliLoop = function stopHeliLoop() {
    const ctx = engine.ctx;
    if (!ctx || !engine._heliNodes) return;
    const { src, lfo, gain } = engine._heliNodes;
    try {
      gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.2);
      src.stop(ctx.currentTime + 0.3);
      lfo.stop(ctx.currentTime + 0.3);
    } catch (err) { /* already stopped */ }
    engine._heliNodes = null;
  };

  // --- SFX dispatcher (the interface Builder B modules call) --------------
  // B calls G.audio.play(name) with: 'crash', 'weaponSwitch', 'pickup',
  // 'gunshot', 'enemyShot', 'heli', 'heliHit'. This table covers those
  // plus the spec's SFX names ('shoot', 'hit', 'siren') and UI sounds.
  const SFX = {
    shoot: sfxGunshot,
    gunshot: sfxGunshot,
    enemyShot: sfxEnemyShot,
    hit: sfxHit,
    pickup: sfxPickup,
    crash: sfxCrash,
    weaponSwitch: sfxWeaponSwitch,
    heliHit: sfxHeliHit,
    uiClick: sfxUiClick,
    click: sfxUiClick,
    engineStart: sfxEngineStart,
    siren: () => engine.startSiren(),
    sirenStop: () => engine.stopSiren(),
    heli: () => engine.startHeliLoop(),
    heliStop: () => engine.stopHeliLoop(),
  };

  engine.play = function play(name) {
    if (engine.muted) return false;
    const fn = SFX[name];
    if (!fn) return false;
    fn();
    return true;
  };

  // --- music bus -----------------------------------------------------------
  // radio.js registers one pattern per station with registerMusicPattern
  // and switches with setStation. A pattern is { bpm, wave, bass: [midi
  // notes, one per 8th-note step, 0 = rest] }. Until a pattern is
  // registered the bus plays a plain neutral pulse so startMusicLoop
  // never fails silently.
  const FALLBACK_PATTERN = { bpm: 100, wave: 'triangle', bass: [45, 0, 45, 0, 48, 0, 43, 0] };

  engine.registerMusicPattern = function registerMusicPattern(index, pattern) {
    engine.stationPatterns[index] = pattern;
    return engine;
  };

  engine.setStationPatterns = function setStationPatterns(patterns) {
    engine.stationPatterns = patterns.slice();
    return engine;
  };

  engine.setStation = function setStation(index) {
    engine.station = index;
    engine._musicStep = 0;
    return engine;
  };

  function musicStep() {
    const ctx = engine.ctx;
    if (!ctx) return;
    const pattern = engine.stationPatterns[engine.station] || FALLBACK_PATTERN;
    const notes = pattern.bass || [];
    if (!notes.length) return;
    const note = notes[engine._musicStep % notes.length];
    engine._musicStep += 1;
    if (!note) return;
    const stepSeconds = 60 / (pattern.bpm || 100) / 2;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = pattern.wave || 'triangle';
    osc.frequency.value = midiToFreq(note);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + stepSeconds * 0.9);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(engine.musicGain);
    osc.start(t0);
    osc.stop(t0 + stepSeconds);
  }

  engine.startMusicLoop = function startMusicLoop() {
    const ctx = ensureContext();
    if (!ctx || engine._musicTimer) return engine;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const pattern = engine.stationPatterns[engine.station] || FALLBACK_PATTERN;
    const stepMs = (60 / (pattern.bpm || 100) / 2) * 1000;
    engine._musicStep = 0;
    engine._musicTimer = setInterval(musicStep, stepMs);
    engine.started = true;
    return engine;
  };

  engine.stopMusic = function stopMusic() {
    if (engine._musicTimer) {
      clearInterval(engine._musicTimer);
      engine._musicTimer = null;
    }
    engine.started = false;
    return engine;
  };

  // Backwards-friendly aliases for the radio module.
  engine.startRadio = engine.startMusicLoop;
  engine.stopRadio = engine.stopMusic;

  // --- lifecycle -----------------------------------------------------------

  engine.resume = function resume() {
    const ctx = ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return engine;
  };

  engine.setMuted = function setMuted(muted) {
    engine.muted = !!muted;
    if (engine.master) engine.master.gain.value = engine.muted ? 0 : 0.9;
    return engine;
  };

  // Wire the engine into the shared game state: Builder B modules call
  // G.audio.play(name) defensively, so this is the only coupling point.
  engine.attachToGame = function attachToGame(G) {
    G.audio = {
      play: (name) => engine.play(name),
      engine,
    };
    G.radio = G.radio || {};
    return G.audio;
  };

  return engine;
}

// One shared engine for the game. main.js creates it once and attaches
// it to G; tests may create their own with createAudioEngine().
export const audioEngine = createAudioEngine();
