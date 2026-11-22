# Builder B — systems contract (for Builder A + Builder C wiring)

All nine Builder B modules operate on ONE shared game-state object `G`
(created by main.js / Builder A) and expose named ES-module exports.
No module reads another builder's internals beyond the fields listed here.

## Shared state fields my modules use (read / write)

- `G.player` — `{ x, y, angle, aimAngle, health, maxHealth, cash, onFoot,
  car, speed, sprinting }`. `speed` is the player's current movement speed
  (on foot or in car). `car` is the car object the player is in, or null.
- `G.cars` — array of car objects `{ id, x, y, angle, speed, topSpeed,
  accel, type, color, parked, driver, upgrades: { engine, armor, tires,
  brakes }, paint, health }`. Upgrades are stored PER CAR (garage.js).
- `G.world` — `{ size: 3200, roads: [200, 600, 1000, 1400, 1800, 2200,
  2600, 3000], buildings: [{x,y,w,h}], findRoute(x1,y1,x2,y2),
  nearestRoadPoint(x,y), isBlockedAt(x,y), sprayShop: {x,y,r},
  garage: {x,y,r}, gunStore: {x,y}, docks: {x,y}, hideout: {x,y},
  airport: {x,y}, bank: {x,y}, club: {x,y}, marina: {x,y},
  market: {x,y}, downtown: {x,y} }`. Where a helper is missing my code
  falls back to the spec-fixed 8x8 grid geometry (roads at 200+i*400).
- `G.heat` (0..100), `G.stars` (0..5), `G.wantedCover` (bool, mission cover).
- `G.time` — `{ t, night: 0..1, hour }`.
- `G.input` — `{ keys: Set, mouseX, mouseY, mouseDown, justClicked,
  interactPressed }`. `G.autoInput` — written by autopilot.js, same shape;
  when `G.autopilotActive` is true, player/vehicles read `G.autoInput`
  instead of `G.input` (autopilot drives BEFORE the dialog branch).
- `G.bullets` — `[{ x, y, vx, vy, dmg, from: 'player'|'enemy', life }]`.
- `G.enemies` — `[{ x, y, hp, maxHp, state, shootTimer, targetX, targetY }]`.
- `G.pickups` — `[{ kind: 'health'|'ammo'|'money', x, y, amount }]`.
- `G.crates` — `[{ kind: 'smg'|'shotgun'|'ammo', x, y, taken }]`.
- `G.cover` — `[{ x, y, w, h }]` (blocks enemy bullets).
- `G.police` — `{ footCops: [], patrolCars: [], roadblocks: [],
  hideTimer, arrestTimer }`. Stars are NEVER read off these arrays;
  always from `G.stars` / `starsFromHeat(G.heat)`.
- `G.helicopter` — `{ active, x, y, state, damage, retreatTimer,
  spotlightOnPlayer, rotor }`. Heat decay is blocked ONLY when
  `spotlightOnPlayer` is true, never merely because the heli is active.
- `G.weapons` — `{ owned: { pistol, smg, shotgun }, current,
  ammo: { pistol, smg, shotgun }, cooldown }`.
- `G.radio` — `{ station: 0, started, nodes }`.
- `G.garage` — `{ open, menuEl, zone }`.
- `G.mission` — `{ id, stage, state: 'none'|'dialog'|'active'|'done'|
  'failed', timeLeft, data: {}, dialogOpen }`.
- `G.paused`, `G.state` (`'title'|'playing'|'paused'|'gameover'`).
- `G.camera` — `{ x, y }`. `G.particles` — array. `G.audio` — optional
  helpers `{ play(name) }` (called defensively: `G.audio?.play?.(...)`).
- `G.rng` — deterministic random function, `G.rng()` in [0,1).
- `G.shootoutActive` (bool) + `G.shootoutCenter` `{x,y}` — set by
  missions.js during shootout stages; police.js holds a ring then.

## Who calls what (Builder C wires main.js)

- Every frame (playing): `updateWantedHeat`, `updatePolice`,
  `updateHelicopter`, `updateCombat`, `updateWeaponCrates`,
  `updateMissions`, `updateAutopilot` (before dialog branch),
  `updateGarage`, `updateRadio`.
- Render: `drawPolice`, `drawHelicopter`, `drawCombat`,
  `drawWeaponCrates` (from render.js), `drawHud` (hud.js draws all HUD).
- Input keys: `1/2/3` select weapon, `Q` cycle weapon, `R` cycle radio,
  `E` interact / accept dialog / enter-exit car / open garage in zone.
  `Esc` closes garage menu first, then pauses.

## Exported interfaces per module (function names C needs)

- police.js — `WANTED_STAR_THRESHOLDS`, `starsFromHeat`,
  `updateWantedHeat`, `addHeat`, `updatePolice`, `dispatchPolice`,
  `clearAllPolice`, `drawPolice`.
- combat.js — `ENEMY_HP`, `spawnEnemy`, `updateCombat`, `damagePlayer`,
  `spawnHealthPickup`, `spawnAmmoPickup`, `spawnCover`,
  `updatePickups`, `clearCombat`, `drawCombat`.
- weapons.js — `WEAPON_DEFS`, `createWeaponsState`, `selectWeapon`,
  `cycleWeapon`, `giveWeapon`, `addAmmo`, `canFire`, `fireWeapon`,
  `spawnWeaponCrate`, `updateWeaponCrates`, `drawWeaponCrates`.
- helicopter.js — `HELI_SPAWN_STARS`, `createHelicopterState`,
  `updateHelicopter`, `takeHelicopterDamage`, `forceHelicopter`,
  `drawHelicopter`.
- garage.js — `GARAGE_UPGRADES`, `GARAGE_PAINTS`, `createGarageState`,
  `updateGarage`, `openGarage`, `closeGarage`, `buyUpgrade`,
  `buyPaint`, `isInGarageZone`, `drawGarageZone`, plus
  `garageEscapeConsumed` (main.js MUST call this before its own pause
  toggle — Esc closes the garage first), `garagePurchaseCount` (m11
  watches this), `cheapestAvailableUpgrade` (autopilot m11 step),
  `nextUpgradePrice`, `effectiveTopSpeed`, `damageMultiplierForCar`,
  `applyUpgradesToCar`, `garageZone`. Armor also syncs
  `G.player.armorFactor` while the menu is open (combat.js reads that
  field in damagePlayer); vehicles.js should use
  `damageMultiplierForCar(car)` for car collision damage. While the
  menu is open `G.paused` is true — main.js skips world updates then.
- radio.js — `RADIO_STATIONS`, `createRadioState`, `cycleStation`,
  `setStation`, `startRadio`, `stopRadio`, `updateRadio`,
  `currentStationName`, plus `currentStation`, `attachRadioContext`
  (audio.js can share one AudioContext later), `RADIO_PATTERNS`
  (bass lines for the audio.js music bus), `audioEngine` (detects the
  attached audio.js engine) and `registerRadioPatterns`. NOTE (22 Nov,
  batch 2): audio.js (A-2, commit af9acb4) landed DURING batch 2, so
  radio.js was wired to it in-session: when G.audio.engine is present
  radio.js registers its 3 patterns with
  engine.registerMusicPattern() and drives engine.setStation() /
  startMusicLoop() / stopMusic() — ONE audio source, no double music.
  With no engine present it falls back to its own AudioContext +
  step sequencer (kick/hats/pads/arps over the same bass lines).
- missions.js — `MISSION_ARC`, `startMission`, `acceptMissionDialog`,
  `updateMissions`, `failMission`, `completeMissionStage`,
  `missionObjectiveText`, `currentMission`, plus `missionDef`,
  `nextMissionDef`, `landmark`, `nearestRoadPoint`, `gridRoute`,
  `completeMission`, `clearMissionEntities`, `checkMissionTrigger`
  (auto-offer radius 50 at the Fixer Garage),
  `m2OnFootTarget` / `courierRoadPoint` (m2 freeze-trap fallback:
  walk to the courier's nearest ROAD point, never at the moving
  courier). m7/m9/m12 set their wanted cover AFTER the mission starts
  (setHeat inside accept/setup, never before). m12 death/caught
  restarts from stage 0 = stage (a). `G.onMissionComplete(def)` is
  called on completion (autosave hook for save.js).
- autopilot.js — `createAutopilotState`, `updateAutopilot`,
  `autopilotDriveTo`, `autopilotChase`, `findRouteGrid`.
- hud.js — `drawHud`, `drawMinimap`, `drawWantedStars`,
  `drawObjectiveBanner`.
