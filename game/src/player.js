// player.js — Rook on foot and in a car. WASD/arrows move, mouse
// aims, click shoots, Shift sprints; E enters/exits a car, steals
// parked cars, and carjacks traffic cars (the driver flees).
//
// The player update is the call the arc progress log watches: after
// EVERY edit, verify it still runs (the log must show movement).

import { PLAYER_WALK_SPEED, PLAYER_SPRINT_MULTIPLIER, PLAYER_MAX_HEALTH } from './config.js';
import { isDown, moveVector } from './input.js';
import { fireWeapon, selectWeapon, cycleWeapon, tickWeaponCooldown } from './weapons.js';
import { updatePlayerCar } from './vehicles.js';
import { addHeat } from './police.js';
import { removeTrafficCar } from './traffic.js';
import { spawnPedestrian } from './pedestrians.js';

// Create the player state. The shape matches the Builder B contract:
// { x, y, angle, aimAngle, health, maxHealth, cash, onFoot, car,
//   speed, sprinting }.
export function createPlayerState() {
  return {
    x: 600,
    y: 800,
    angle: 0,
    aimAngle: 0,
    health: PLAYER_MAX_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    cash: 0,
    onFoot: true,
    car: null,
    speed: 0,
    sprinting: false,
    armorFactor: 1,
  };
}

// Effective input: the autopilot's autoInput while the autopilot is
// active, otherwise the live keyboard/mouse state.
function effectiveInput(G) {
  if (G.autopilotActive && G.autoInput) return G.autoInput;
  return G.input;
}

// Nearest car the player could enter (parked or traffic), within range.
function nearestEnterableCar(G, range) {
  const p = G.player;
  let best = null;
  let bestD = range;
  for (const car of G.cars || []) {
    if (car.wrecked || car === p.car) continue;
    const d = Math.hypot(car.x - p.x, car.y - p.y);
    if (d < bestD) {
      best = car;
      bestD = d;
    }
  }
  return best;
}

// Step out of the car onto the roadside, clear of the car's body.
function exitCar(G) {
  const p = G.player;
  const car = p.car;
  if (!car) return false;
  const side = car.angle + Math.PI / 2;
  p.x = car.x + Math.cos(side) * 34;
  p.y = car.y + Math.sin(side) * 34;
  // Never exit inside a building: try the other side, then behind.
  const blocked = (x, y) =>
    G.world && typeof G.world.isBlockedAt === 'function'
      ? G.world.isBlockedAt(x, y, 10)
      : false;
  if (blocked(p.x, p.y)) {
    p.x = car.x - Math.cos(side) * 34;
    p.y = car.y - Math.sin(side) * 34;
  }
  if (blocked(p.x, p.y)) {
    p.x = car.x - Math.cos(car.angle) * 40;
    p.y = car.y - Math.sin(car.angle) * 40;
  }
  p.onFoot = true;
  p.car = null;
  p.speed = 0;
  p.angle = car.angle;
  car.parked = true;
  return true;
}

// Step into a car. Stealing a parked car and carjacking a traffic car
// are both thefts: they add heat. A carjacked driver flees on foot.
function enterCar(G, car) {
  const p = G.player;
  if (!car || car.wrecked) return false;
  const hadDriver = !!car.driver;
  if (hadDriver) {
    // Carjack: the driver flees on foot, the car leaves traffic.
    removeTrafficCar(G, car);
    spawnPedestrian(G, car.x + 30, car.y + 30, {
      flee: true,
      fleeFrom: { x: car.x, y: car.y },
    });
    car.driver = null;
  }
  car.parked = false;
  p.car = car;
  p.onFoot = false;
  p.x = car.x;
  p.y = car.y;
  p.angle = car.angle;
  p.speed = 0;
  if (G.audio) G.audio.play && G.audio.play('engineStart');
  // Theft adds heat — but only the first time: re-entering a car the
  // player already owns (exited earlier) is not a new theft.
  if (!car.playerOwned) {
    addHeat(G, hadDriver ? 10 : 6);
    car.playerOwned = true;
  }
  return true;
}

// Handle the E key: enter/exit a car. Skipped while a mission dialog
// is open (E accepts the dialog there) or the garage menu is open.
function handleInteract(G) {
  const p = G.player;
  const input = effectiveInput(G);
  if (!input || !input.interactPressed) return;
  if (G.mission && G.mission.dialogOpen) return;
  if (G.garage && G.garage.open) return;
  if (!p.onFoot) {
    exitCar(G);
    return;
  }
  const car = nearestEnterableCar(G, 62);
  if (car) enterCar(G, car);
}

// Aim from the mouse: screen position -> world position via the camera.
function updateAim(G) {
  const p = G.player;
  const input = effectiveInput(G);
  const cam = G.camera || { x: 0, y: 0 };
  if (!input) return;
  const wx = (input.mouseX || 0) + cam.x;
  const wy = (input.mouseY || 0) + cam.y;
  p.aimAngle = Math.atan2(wy - p.y, wx - p.x);
  // On foot the body faces the aim direction; in a car the car faces
  // the drive direction and only the aim moves.
  if (p.onFoot) p.angle = p.aimAngle;
}

// Walk on foot: WASD/arrows, Shift sprint, slide along walls.
function updateOnFoot(G, dt) {
  const p = G.player;
  const input = effectiveInput(G);
  if (!input) return;
  const mv = moveVector(input);
  const sprinting = isDown(input, ['ShiftLeft', 'ShiftRight']);
  p.sprinting = sprinting && (mv.x !== 0 || mv.y !== 0);
  const speed = PLAYER_WALK_SPEED * (p.sprinting ? PLAYER_SPRINT_MULTIPLIER : 1);
  p.speed = (mv.x !== 0 || mv.y !== 0) ? speed : 0;
  if (p.speed === 0) return;
  const nx = p.x + mv.x * speed * dt;
  const ny = p.y + mv.y * speed * dt;
  const blocked = (x, y) =>
    (G.world && typeof G.world.isBlockedAt === 'function'
      ? G.world.isBlockedAt(x, y, 10)
      : false);
  // Slide along walls: full step, then X-only, then Y-only.
  if (!blocked(nx, ny)) { p.x = nx; p.y = ny; }
  else if (!blocked(nx, p.y)) { p.x = nx; }
  else if (!blocked(p.x, ny)) { p.y = ny; }
}

// Shooting on foot: mouse held OR the just-clicked edge flag fires a
// shot (a very quick click must never be lost). Weapon keys 1/2/3
// select, Q cycles. Cooldown ticks every frame.
function updateShooting(G, dt) {
  const p = G.player;
  tickWeaponCooldown(G, dt);
  if (!p.onFoot) return;
  const input = effectiveInput(G);
  if (!input) return;
  if (input.pressed && input.pressed.has('Digit1')) selectWeapon(G, 'pistol');
  if (input.pressed && input.pressed.has('Digit2')) selectWeapon(G, 'smg');
  if (input.pressed && input.pressed.has('Digit3')) selectWeapon(G, 'shotgun');
  if (input.pressed && input.pressed.has('KeyQ')) cycleWeapon(G);
  const wantShoot = input.mouseDown || input.justClicked;
  if (wantShoot) {
    const fired = fireWeapon(G);
    if (fired) {
      // A gunshot scares nearby pedestrians and raises a little heat.
      G.lastGunshot = { x: p.x, y: p.y, t: (G.time ? G.time.t : 0) };
      addHeat(G, 2);
    }
  }
}

// One player frame. Called by main.js every playing frame — the arc
// progress log proves this call still runs by showing movement.
//
// Order: aim, then E (enter/exit), then walk or drive, then shoot.
// Manual driving is skipped on frames the autopilot drove
// (G.autopilotDrove): the manual branch would brake the car back to
// ~0 every frame and it could never build speed.
export function updatePlayer(G, dt) {
  const p = G.player;
  if (!p || G.state !== 'playing') return;
  updateAim(G);
  handleInteract(G);
  if (p.onFoot) {
    updateOnFoot(G, dt);
  } else if (p.car) {
    if (G.autopilotDrove) {
      // Autopilot drove this frame: sync the player to the car only.
      p.x = p.car.x;
      p.y = p.car.y;
      p.angle = p.car.angle;
      p.speed = Math.abs(p.car.speed || 0);
    } else {
      updatePlayerCar(G, dt);
    }
  }
  updateShooting(G, dt);
}

// Draw Rook: a bright figure with a white outline on foot (findable in
// one second), riding inside the car when driving (the car draws the
// player ring instead).
export function drawPlayer(ctx, G, cam) {
  const p = G.player;
  if (!p || !p.onFoot) return;
  const px = cam ? cam.x : 0;
  const py = cam ? cam.y : 0;
  const x = p.x - px;
  const y = p.y - py;
  ctx.fillStyle = 'rgba(40, 30, 90, 0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 4, y + 7, 11, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // Body: bright jacket, white outline.
  ctx.fillStyle = '#ffd23a';
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.stroke();
  // Gun barrel toward the aim direction.
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(p.aimAngle) * 22, y + Math.sin(p.aimAngle) * 22);
  ctx.stroke();
  // Small direction tick.
  ctx.fillStyle = '#222222';
  ctx.beginPath();
  ctx.arc(x + Math.cos(p.aimAngle) * 8, y + Math.sin(p.aimAngle) * 8, 3, 0, Math.PI * 2);
  ctx.fill();
}
