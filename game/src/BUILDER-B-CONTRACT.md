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
  `drawWeaponCrates` (from render.js), `drawHud` (hud.js draws all HUD;
  render.js calls it as `drawHud(ctx, G)` — width/height come from
  `ctx.canvas`).
- Input keys: `1/2/3` select weapon, `Q` cycle weapon, `R` cycle radio,
  `E` interact / accept dialog / enter-exit car / open garage in zone.
  `Esc` closes garage menu first, then pauses.

## KNOWN WIRING GAP — main.js garage pause deadlock (found batch 3, for Builder C)

`openGarage` sets `G.paused = true`, and main.js's frame loop runs
`stepGame` ONLY when `!G.paused` — so while the garage menu is open,
`updateAutopilot` AND `updateGarage` never run, and the frame loop's
own Esc handler explicitly skips when the garage is open
(`pausePressed && !garageOpen`). Net: once the menu opens, the ONLY way
to close it is clicking the DOM Close button; keyboard Esc is dead and
the autopilot cannot act. The autopilot works around it by opening +
buying + closing inside one `updateAutopilot` call (see autopilot.js),
so m11 still completes — but a HUMAN player who opens the menu with E
cannot close it with Esc. Builder C / main.js fix: run
`updateGarage` (at least its Esc-close branch) and the autopilot before
the paused early-exit, or handle Esc-close of the garage menu in the
frame loop itself when `garageOpen`.

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
  NOTE (22 Nov, batch 3): the arc table is NO LONGER defined here —
  it is imported from config.js (`MISSION_ARC as CONFIG_MISSION_ARC`)
  and merged with a small local overlay that adds only the dialogue
  hooks, type labels and shootout details (enemies / crates). config.js
  is the single source of truth for order, rewards and time limits.
- autopilot.js — `createAutopilotState`, `ensureAutopilotState`,
  `enableAutopilot`, `disableAutopilot`, `updateAutopilot`,
  `autopilotDriveTo`, `autopilotChase`, `findRouteGrid`,
  `autopilotAcceptDialog` (the accept action: pulses E for one frame
  into G.autoInput; main.js swaps G.input to G.autoInput after
  updateAutopilot runs, so the dialog branch sees it), plus the
  `AUTOPILOT_*` constants (chase cruise 520, walk recompute 120,
  burst interval 0.45s, ammo pickup at <=6, car-switch thresholds
  350/430 and ranges 200/320). The autopilot writes ONLY to
  G.autoInput (keys rebuilt fresh every frame, edges live one frame),
  drives cars DIRECTLY via vehicles.js `routeCarTo` / `driveRoute` /
  `driveCarToward` and sets `G.autopilotDrove = true` on those frames.
  GARAGE (m11): open + buy + close happen inside ONE updateAutopilot
  call via `openGarage` / `buyUpgrade(cheapestAvailableUpgrade)` /
  `closeGarage` — see the deadlock note below. If the menu is somehow
  left open, updateAutopilot buys (m11 stage 0) and closes it on the
  next call as a safety net. SHOOTOUT: on foot and >450 from the
  arena, the autopilot DRIVES there first (finds a car via
  autopilotDriveTo) — walking the whole way meets the advancing
  enemies mid-city and burns all ammo at moving targets (live m10
  probe 22 Nov: on-foot spawn start, ammo 0, 1 kill in 300s; fixed →
  arena clear in 24s, SMG crate, mission complete). Health/ammo
  pickups and weapon crates are sought when near the arena OR within
  300 of Rook (dead-enemy drops count).
- hud.js — `drawHud`, `drawMinimap`, `drawWantedStars`,
  `drawObjectiveBanner`, `drawHealthBar`, plus the `HUD_*` size
  constants (stars 40px, banner 28px bold, minimap 180px, health
  18px). Radio station name comes from radio.js `currentStationName`
  — the same source as the #radio-station DOM badge — so canvas and
  badge can never disagree; the equalizer animates from
  `G.radio.eqLevel` + `G.time.t`.
