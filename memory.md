# Pesident Evil — project memory

Last reviewed: 2026-10-04

## Project summary

`Pesident Evil` is a browser-based third-person zombie-survival shooter set on the PES University Ring Road campus in Bengaluru. It is built with Vite, strict TypeScript, and three.js. Solo play runs the authoritative simulation in the browser; co-op uses a PeerJS/WebRTC host/client model.

## How to run

Requirements:

- Node.js/npm compatible with the Vite and TypeScript versions in `package.json`.
- A modern browser with WebGL/WebAudio/WebRTC support.
- `npm install` must be run first. At the time of this review, `node_modules/` was absent, so commands were not executed.

Main development server:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`. The Vite server is pinned to `127.0.0.1:5173` in `vite.config.ts`.

Other package scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # vite build
npm run preview     # vite preview; normally run after build
```

The project has no automated test script in `package.json`. The standalone lab pages below are the main manual test surfaces.

### Development URLs

All are served by the same Vite server:

- `/` or `/index.html` — main game (`src/main.ts`).
- `/campus-viewer.html` — procedural campus/world viewer (`src/world/campusViewer.ts`).
- `/props-viewer.html` — prop viewer; `?showroom=1` shows all props and LODs (`src/world/propsViewer.ts`).
- `/fx-test.html` — rendering/particle/post-processing lab (`src/render/fxTest.ts`).
- `/audio-test.html` — procedural audio lab (`src/audio/test.ts`).

Useful URL option:

- `?flat` on the main game switches from the default multi-level movement simulation to the older flat movement mode.

### Co-op configuration

Co-op is peer-to-peer through PeerJS. Optional TURN settings are read at build/runtime through Vite environment variables:

- `VITE_TURN_URLS` — comma-separated TURN URLs.
- `VITE_TURN_USERNAME` — TURN username.
- `VITE_TURN_CREDENTIAL` — TURN credential.
- `VITE_TURN_ENDPOINT` — URL returning `{ "iceServers": [...] }` with short-lived credentials.

For local testing, put these in `.env.local` before starting Vite. In deployment, the README describes corresponding repository secrets used by the deployment workflow; no workflow file was present in the top-level file listing during this review.

## Source map

### Application entrypoints

- `src/main.ts` — creates the `Game` and starts the main application.
- `src/core/Game.ts` — top-level game composition: renderer, campus, sky, assets, audio bridge, camera, characters, HUD/menu, simulation, and solo/co-op lifecycle.
- `src/core/Engine.ts` — three.js renderer/animation loop and frame timing.
- `src/core/Input.ts` — keyboard/mouse input translated into `PlayerInput` snapshots.

### `src/core/` — shared runtime services

- `Assets.ts` — GLB and texture loading/caching.
- `AudioBridge.ts` — translates simulation/game events into audio and NPC barks.
- `Engine.ts` — renderer, canvas, frame loop, timing.
- `Events.ts` — plain-data gameplay event types/event bus contracts.
- `Game.ts` — application coordinator.
- `Input.ts` — player controls and input snapshots.
- `Profile.ts` — saved player name/look/profile.
- `Settings.ts` — quality presets, settings, high scores, local persistence.
- `wakeTimer.ts` — worker-backed timer for background-tab/co-op host ticks.

### `src/sim/` — authoritative gameplay simulation

- `World.ts` — fixed-timestep world, actors, waves, movement, damage, interactions, stations, and role-specific solo/host/client behavior.
- `actors.ts` — survivors, zombies, NPCs, pickups and actor state.
- `weapons.ts` — weapon definitions and combat parameters.
- `Collision.ts` — stacked 2.5D prism/ramp/cylinder collision and ground/ledge queries.
- `LayeredNav.ts` — layered 1 m navigation graph for multi-level surfaces.
- `navWorker.ts` — Web Worker that builds/queries navigation data off the main thread.
- `NavGrid.ts` — grid/navigation support used by viewers and world setup.
- `flowfield.ts` — flow-field pathfinding (Dial-style shortest paths).
- `aim.ts` — camera/aim calculations and camera view modes.

Simulation contract: fixed 60 Hz, driven by `PlayerInput`; it should not read DOM input directly. It emits plain-data events consumed by rendering, audio, and UI.

### `src/world/` — procedural campus and world assets

- `Campus.ts` — high-level campus builder and build result.
- `layout.ts` — authored campus layout constants: buildings, roads, walls, gates, stations, spawns, bounds, and landmarks.
- `terrain.ts` — terrain height/slope application and terrain collision support.
- `buildings.ts`, `blocks.ts`, `bblock.ts`, `gjbc.ts`, `mrd.ts`, `mrdInterior.ts`, `admissionHall.ts` — procedural building shells/interiors.
- `gjb/` — Golden Jubilee Block sub-builders: ground, ramp, rooms, interiors, parking, east block, utilities.
- `landscape.ts`, `geom.ts`, `shapes.ts`, `landmarks.ts`, `signs.ts` — roads, landscape geometry, helper geometry, campus landmarks/signage.
- `kit.ts`, `materials.ts` — shared world construction/material system and shader lighting hooks.
- `Props.ts` — runtime GLB prop instancing and distance/LOD management.
- `trees.ts` — runtime vegetation placement/system.
- `vegetation/` — procedural tree/shrub/lawn generation, atlases, impostors, and shaders.
- `Sky.ts` — physically based sky, clouds, stars, moon, and day/dusk/night lighting.
- `traffic.ts` — dense dynamic Outer Ring Road traffic using existing vehicle GLBs; exposes moving obstacles to the authoritative simulation for actor collisions and zombie driver ambushes, and hides traffic outside the camera-facing visibility cone/draw distance.
- Survivors can press `E` beside a vehicle after its driver has been pulled out, use `WASD` to drive along the road lanes, and press `E` again to exit.
- `data/osm.json` — generated OpenStreetMap-derived campus data.
- `campusViewer.ts`, `propsViewer.ts` — standalone viewer entrypoints.

World conventions from `docs/ARCHITECTURE.md`: metres, Y-up, three.js right-handed coordinates; +X east, -Z north, +Z south. The origin is near the Golden Jubilee Block OSM centroid.

### `src/render/` — visual presentation

- `Post.ts` — post-processing chain (AO, bloom, ACES, SMAA, etc.).
- `CameraRig.ts` — third-person camera behavior.
- `Characters.ts` — character manager and weapon model integration.
- `GlbCharacters.ts` — GLB character loading/animation setup.
- `ProceduralCharacter.ts` — fallback/procedural character rendering.
- `Fx.ts`, `Grenades.ts` — gameplay visual effects and grenade presentation.
- `fx/ParticleLayer.ts`, `fx/DecalLayer.ts`, `fx/textures.ts` — particle/decal effects support.
- `fxTest.ts` — FX lab page entrypoint.

### `src/audio/` — procedural WebAudio

- `AudioManager.ts` — public audio service contract.
- `synth.ts`, `dsp.ts`, `render.ts` — sound synthesis/rendering helpers.
- `sfx.ts`, `ambience.ts`, `music.ts` — gunshots, zombie/world ambience, adaptive score.
- `barks.ts` — NPC bark data and speech-synthesis content.
- `test.ts` — audio lab entrypoint.

### `src/net/` — co-op networking

- `Net.ts` — PeerJS transport, reliable control/event channel, unordered binary channel, room registration/heartbeat.
- `Coop.ts` — host/client session logic and input/snapshot flow.
- `protocol.ts` — wire message formats and compact readers/writers.
- `snapshot.ts` — host snapshot creation and client snapshot application/interpolation.
- `ice.ts` — STUN/TURN configuration and optional endpoint loading.

### `src/ui/`

- `Menu.ts` — main/pause/lobby/menu screens.
- `Hud.ts` — in-game HUD, minimap, leaderboard and prompts.
- `style.css` — UI overlay styling.

## Static assets and supporting folders

- `public/models/characters/` — character GLBs and LODs.
- `public/models/weapons/` — pistol, shotgun, rifle, SMG, cricket bat GLBs.
- `public/models/props/` — vehicles, furniture, pickups, barriers, lamps and LOD GLBs.
- `public/textures/` — PBR texture sets and foliage atlases.
- `reference/` — campus notes, OSM exports, and visual reference images/data.
- `docs/ARCHITECTURE.md` — detailed architecture and asset contracts; consult before changing simulation/world/asset interfaces.
- `tools/blender/` — older/headless Blender character, weapon, and legacy prop generators.
- `tools/props/` — current procedural prop build pipeline and Blender helper modules.
- `tools/osm/` — OSM extraction script and raw OSM input.
- `tools/trees/` — vegetation downloads and atlas generation.
- `tools/cinematic/` — cinematic tooling and local upload helper.

## Build/data pipelines

These are not npm scripts; they require their external tools and source assets:

```bash
# OSM data → src/world/data/osm.json
python tools/osm/extract.py

# Current props pipeline (Blender 5.2, headless)
blender -b --factory-startup -P tools/props/build.py -- all
blender -b --factory-startup -P tools/props/build.py -- all --preview

# Weapons (subset or all, see script help/comments)
blender -b --factory-startup -P tools/blender/weapons.py -- pistol rifle

# Characters (requires downloaded Quaternius source assets under tools/blender/_downloads/)
blender -b --factory-startup -P tools/blender/characters.py

# Vegetation assets (requires source downloads and network/tool dependencies)
sh tools/trees/download.sh
python tools/trees/build_atlas.py
```

The current props pipeline uses ImageMagick/cwebp and source assets under `tools/props`/download locations. The README and script headers are authoritative for detailed asset prerequisites.

## Configuration and conventions

- `vite.config.ts`: relative base (`./`) for sub-path deployment, local host/port, ignored build/media paths, ES2022 build target, and a large chunk warning limit.
- `tsconfig.json`: ES2022, ES modules, bundler resolution, DOM libs, strict type checking, JSON imports, and `src` as the only included TypeScript tree.
- `package.json`: private ESM package; runtime dependencies are `three`, `postprocessing`, `n8ao`, and `peerjs`.
- Quality presets scale resolution, shadows, AO, view distance, zombie cap, and animation LOD.
- User settings/profile/high scores are stored locally by the browser.

## First checks after changing code

```bash
npm run typecheck
npm run build
npm run dev
```

Then manually smoke-test `/`, `/campus-viewer.html`, `/props-viewer.html?showroom=1`, `/fx-test.html`, and `/audio-test.html` in a WebGL-capable browser. For co-op changes, test both host and client, and use TURN settings when testing restrictive networks.

## Known review state

- Working tree was clean when this file was created.
- `node_modules/` was not present, so dependency installation and command execution remain pending.
- No test runner or CI configuration was found in the top-level project listing.
- Existing detailed references: `README.md` and `docs/ARCHITECTURE.md`.
