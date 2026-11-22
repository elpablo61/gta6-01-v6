// input.js — keyboard + mouse state for Crescent Bay.
// The state shape matches the Builder B contract exactly: G.input holds
// { keys, mouseX, mouseY, mouseDown, justClicked, interactPressed }.
// keys is a Set of KeyboardEvent.code values held down right now.
// Edge flags (justClicked, interactPressed, and the pressed set) are set
// the moment the event happens and are cleared ONLY at the end of the
// frame by clearEdgeFlags, after every gameplay system has read them —
// a click that begins and ends inside one frame must still fire a shot.

// Key bindings, by KeyboardEvent.code.
export const KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE', 'Enter'],
  handbrake: ['Space'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weapon3: ['Digit3'],
  cycleWeapon: ['KeyQ'],
  radio: ['KeyR'],
  pause: ['Escape', 'KeyP'],
};

// Create a fresh input state. Nothing here touches the DOM, so this is
// safe to construct in Node for smoke tests.
export function createInputState() {
  return {
    keys: new Set(),
    // Edge-triggered key presses this frame (cleared by clearEdgeFlags).
    pressed: new Set(),
    mouseX: 0,
    mouseY: 0,
    mouseDown: false,
    // True on the frame the mouse button went down.
    justClicked: false,
    // True on the frame E (or Enter) was pressed: interact / accept /
    // enter-exit car / open garage.
    interactPressed: false,
    // Internal: bound listener handles, filled in by attachInput.
    _listeners: null,
  };
}

// Is any of the given codes held down right now?
export function isDown(state, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  for (const code of list) {
    if (state.keys.has(code)) return true;
  }
  return false;
}

// Was any of the given codes pressed this frame (edge-triggered)?
export function wasPressed(state, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  for (const code of list) {
    if (state.pressed.has(code)) return true;
  }
  return false;
}

// Consume one edge press: returns true once, then removes it, so the
// same E press cannot be eaten twice (dialog accept AND car enter).
export function consumePressed(state, code) {
  if (state.pressed.has(code)) {
    state.pressed.delete(code);
    if (KEYS.interact.includes(code)) state.interactPressed = false;
    return true;
  }
  return false;
}

// Movement vector from the held keys, normalized, in screen space
// (x right, y down). Returns { x, y } with length 0 or 1.
export function moveVector(state) {
  let x = 0;
  let y = 0;
  if (isDown(state, KEYS.left)) x -= 1;
  if (isDown(state, KEYS.right)) x += 1;
  if (isDown(state, KEYS.up)) y -= 1;
  if (isDown(state, KEYS.down)) y += 1;
  if (x !== 0 && y !== 0) {
    const inv = 1 / Math.SQRT2;
    x *= inv;
    y *= inv;
  }
  return { x, y };
}

// Attach DOM listeners. target is usually window; mouse position is
// tracked relative to the canvas element so aim coordinates are in
// canvas pixels. Safe to call in a browser only — guards window.
export function attachInput(state, canvas) {
  if (typeof window === 'undefined' || state._listeners) return state;

  const onKeyDown = (e) => {
    if (e.repeat) return;
    state.keys.add(e.code);
    state.pressed.add(e.code);
    if (KEYS.interact.includes(e.code)) state.interactPressed = true;
    // Keep arrows / space from scrolling the page while playing.
    if (
      e.code === 'Space' || e.code.startsWith('Arrow') ||
      e.code === 'Tab'
    ) {
      e.preventDefault();
    }
  };
  const onKeyUp = (e) => {
    state.keys.delete(e.code);
  };
  const onMouseMove = (e) => {
    if (canvas && canvas.getBoundingClientRect) {
      const r = canvas.getBoundingClientRect();
      state.mouseX = e.clientX - r.left;
      state.mouseY = e.clientY - r.top;
    } else {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
    }
  };
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    onMouseMove(e);
    state.mouseDown = true;
    // Set the edge flag immediately when the press happens, so a very
    // quick click is never lost between frames.
    state.justClicked = true;
  };
  const onMouseUp = (e) => {
    if (e.button !== 0) return;
    state.mouseDown = false;
  };
  const onBlur = () => {
    // Losing the window must never leave a key stuck down.
    state.keys.clear();
    state.mouseDown = false;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  state._listeners = { onKeyDown, onKeyUp, onMouseMove, onMouseDown, onMouseUp, onBlur };
  return state;
}

export function detachInput(state) {
  if (typeof window === 'undefined' || !state._listeners) return state;
  const l = state._listeners;
  window.removeEventListener('keydown', l.onKeyDown);
  window.removeEventListener('keyup', l.onKeyUp);
  window.removeEventListener('mousemove', l.onMouseMove);
  window.removeEventListener('mousedown', l.onMouseDown);
  window.removeEventListener('mouseup', l.onMouseUp);
  window.removeEventListener('blur', l.onBlur);
  state._listeners = null;
  return state;
}

// Clear every edge flag. Called by the main loop at the END of the
// frame, after all gameplay code has read the input — never before.
export function clearEdgeFlags(state) {
  state.pressed.clear();
  state.justClicked = false;
  state.interactPressed = false;
  return state;
}

// Build an input state for the autopilot to write into. Same shape as
// the real one (G.autoInput), so player/vehicles can read either.
export function createAutoInputState() {
  return createInputState();
}
