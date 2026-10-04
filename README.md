# Pesident Evil

A third-person zombie-survival shooter set on the **PES University Ring Road campus** (100 Feet Ring Road,
BSK III Stage, Bengaluru). Hold the campus while hordes pour in from the Outer Ring Road through the main gate:
solo with three AI squad-mates (Rahul, Ananya and Manjunath the security guard), or in peer-to-peer co-op with up to
10 friends. Built with three.js for the browser.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open http://127.0.0.1:5173 and click **Play solo**, or **Co-op** to host or join a room. Set your name and look
under **Character**. For a production build:

```bash
npm run build
```

## Controls

| Key | Action |
| --- | --- |
| W A S D / mouse | Move / look |
| Left click | Shoot (or swing the cricket bat) |
| Right click | Aim down sights |
| Shift / Space | Sprint / jump |
| R | Reload |
| E | Interact: enter/exit an abandoned vehicle, buy at stations, revive squad-mates or teammates, repair the gate |
| 1–4 / wheel | Switch weapon |
| V or Q | Quick bat swing |
| F | Squad: hold position / follow me (solo) |
| C | Swap shoulder |
| T | Camera: near / far / high |
| N | Start the next wave now (solo, or the co-op host) |
| Esc / P | Pause (in co-op a menu; the game keeps running) |

## Gameplay

- Waves spawn on the Outer Ring Road and bash the steel main gate. Bullets pass through the gate bars, so shoot them
  while they bash. Hold **E** at the gate between waves to repair or rebuild it.
- Later waves bring runners (wave 3+), crawlers, brutes (wave 5+), and a second front at the **west gate** on PES
  University Road (wave 4+).
- Points come from damage dealt (1 per 5 HP, no overkill), kills, headshots and bat kills, reviving, repairing the
  gate and surviving waves. Spend them at stations: ammo crates, first-aid kits, the
  security locker (shotgun), the canteen stash (SMG) and the NCC armoury (INSAS rifle).
- Downed survivors bleed out unless someone revives them. Your squad will come and revive you.
- The day runs from late afternoon to night as the waves go on: a physically based sky with drifting cumulus (and their
  shadows), a pink twilight, then stars, the moon and Bengaluru's orange skyglow. Street lamps and window lights come on.
- The campus is multi-level: walk up the front ramp to GJB's first floor and the Quad, climb the amphitheatre tiers,
  take the stair onto the two-wheeler parking deck, or duck into the GJB lobby and cafeteria. Zombies follow you up,
  and falls over 4 m hurt. The ground slopes from the main gate down to GJB: the 2-wheeler parking's ground floor is at
  road level, its -1 floor at lawn level, with the PES Innovation Lab at its south end. Add `?flat` to the URL for the
  old flat movement.
- Jump climbs onto anything up to 1.3 m: scooters, sandbags, barricades, benches. Sandbag step stacks lead up onto the
  gates and the Outer Ring Road wall, whose tops you can walk. Zombies climb the same steps, so no perch is safe.

## Co-op

- One player hosts (**Co-op → Host a room**) and shares the 5-letter room code; up to 9 others join with it. The host's
  browser runs the game, so it should be the steadiest machine and connection. It works peer to peer: the public
  PeerJS broker only introduces the browsers (and its TURN relay steps in when a network blocks direct links).
- There is no AI squad in co-op. A wave's total zombie health scales with players / 4 (more zombies and tougher
  ones). Downed players can be revived by teammates; a player who dies sits out (watching a teammate) and comes back
  when the wave is cleared. The game ends when everyone is dead.
- **If friends can't join** ("No network path to the host" / timeouts; the host's console shows "ICE failed"): some
  networks (mobile data, Jio / Airtel fibre, campus Wi-Fi) don't allow direct browser-to-browser links, and the free
  relays PeerJS used to provide are gone. A relay (TURN) server fixes it. Free option: sign up at
  [ExpressTURN](https://www.expressturn.com/) (free plan, 1000 GB/month; a relayed player uses ~95 MB/hour), then add
  three repository secrets under Settings → Secrets and variables → Actions:
  `TURN_URLS` = `turn:<server>:3478,turn:<server>:3478?transport=tcp`, `TURN_USERNAME`, `TURN_CREDENTIAL`. The next
  deploy uses them (the lobby then tags each player "direct" or "via relay"). For local testing put the same values
  in a `.env.local` as `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL`. Alternatively
  `TURN_ENDPOINT` can point at a URL returning `{"iceServers": [...]}` with short-lived credentials (e.g. a Cloudflare
  Worker in front of Cloudflare TURN, which also reaches port 443 through strict firewalls).
- The bottom-left leaderboard ranks players by score, the points they earned (spending doesn't lower it), then kills.
  Names float over teammates' heads. Players can join a game in progress and leave at any time.

## Architecture

See `docs/ARCHITECTURE.md` for the full contracts. In short:

- `src/sim/` is the authoritative simulation. It is fixed-timestep (60 Hz), driven only by `PlayerInput`
  snapshots, and emits plain-data events. In co-op the host runs it and feeds it remote inputs (`src/net/`).
  - Horde pathfinding uses Dial's-algorithm flow fields on a layered 1 m navigation graph (one node per walkable
    surface: terrain, podiums, decks, ramps, stairs), computed in a Web Worker (`LayeredNav.ts`, `navWorker.ts`).
  - Collision is a stacked 2.5D prism/ramp/cylinder grid (walkable tops, ceilings, sloped ramps), also used for
    bullets and line of sight.
- `src/world/` builds the procedural campus from **OpenStreetMap** footprints (`tools/osm/extract.py`) plus
  hand-authored campus data (`layout.ts`) and the 2026 tour-video reference (`reference/CAMPUS_NOTES.md`).
  Geometry is merged and chunked for culling. Facades come from a procedural window/band shader. Trees are procedural
  species models (rain tree, gulmohar, copperpod, ficus, Polyalthia, Terminalia, frangipani, areca palms, saplings) with
  two mesh LODs and runtime-baked impostors in 3 batched draw calls (`src/world/vegetation/`).
- `src/world/Sky.ts` is a physically based atmosphere (transmittance / multiple-scattering / sky-view LUTs) with a
  half-resolution raymarched cumulus layer, cirrus, stars, a phased moon and city skyglow; it also drives cloud shadows.
- `src/render/` holds the post chain (N8AO, bloom, ACES, SMAA), the third-person camera rig, characters (GLB or
  procedural fallback, walk/run speed-matched to their measured foot speed) and FX.
- `src/audio/` is fully procedural WebAudio: gunshots, zombie voices, Bengaluru ambience, an adaptive score, and NPC
  barks via speechSynthesis.
- `src/ui/` holds the HUD, minimap and menus.

Quality presets (low → ultra) scale resolution, shadows, AO, view distance, zombie cap and animation LOD.

## Asset pipeline

- `tools/blender/weapons.py` is a headless Blender generator that writes `public/models/weapons/*`.
- `tools/props/build.py` (Blender 5.2, `blender -b --factory-startup -P tools/props/build.py -- all [--preview]`) builds
  the realistic props in `public/models/props/`: vehicles, street furniture and pickups are modelled in code, textured
  with projected elevation drawings (ImageMagick; shaped Kannada text via `tools/props/render_text.swift`) and procedural
  materials, then baked by Cycles into one WebP atlas per prop (albedo + paint mask, AO/roughness/metalness) with
  `_lod` variants for dense props. It needs ImageMagick and cwebp (Homebrew) and the Poly Haven sources below in
  `tools/blender/_downloads/polyhaven/`. The old flat-colour `tools/blender/props.py` is kept for reference only.
- `tools/blender/characters.py` imports the Quaternius CC0 characters and animations from `tools/blender/_downloads/`
  and writes `public/models/characters/*`.
- `tools/osm/extract.py` converts raw OSM data into `src/world/data/osm.json`.
- `tools/trees/download.sh` + `tools/trees/build_atlas.py` build the vegetation atlases in `public/textures/foliage/`
  (leaf/grass cards, bark columns, lawn) from CC0 Poly Haven / ambientCG sources.

## Credits and licences

- Map data © OpenStreetMap contributors, licensed under ODbL.
- PBR textures from Poly Haven (CC0, https://polyhaven.com): asphalt_02, asphalt_04, aerial_asphalt_01,
  patterned_concrete_pavers, leafy_grass, red_dirt_mud_01, stone_wall_04, painted_plaster_wall, white_stucco,
  concrete_floor_02, concrete_wall_008, granite_tile_03, fine_grained_wood, bark_brown_02, brick_wall_02 (1K JPG).
- Vegetation textures (`public/textures/foliage/`, composited by `tools/trees/build_atlas.py`), all CC0:
  Poly Haven (https://polyhaven.com) leaf / blade textures from the jacaranda_tree, tree_small_02, island_tree_01,
  pachira_aquatica_01, grass_bermuda_01, grass_medium_02, shrub_04 and fern_02 models, and the chinese_hackberry_bark,
  palm_tree_bark and japanese_sycamore bark sets; ambientCG (https://ambientcg.com) Grass005 lawn.
- The tree generator's branching model is inspired by EZ-Tree by Dan Greenheck (MIT, https://github.com/dgreenheck/ez-tree);
  no EZ-Tree code or textures are shipped.
- Characters and animations: Quaternius, Universal Base Characters and Universal Animation Library 1 & 2 (CC0).
- Props from Poly Haven models (CC0, https://polyhaven.com), recoloured / decimated / re-baked by `tools/props`:
  Plastic Monobloc Chair 01 by Kuutti Siitonen (`plastic_chair.glb`, the chairs of `cafe_table_set.glb`) and
  Old Military Crate by Jack Mava (`ammo_crate.glb`); the sandbag hessian is Poly Haven's hessian_230 texture
  (colormass / Rico Cilliers, CC0). The granite bench and the stone of the globe plinth are procedural.
- Everything else (weapons, the other props, audio, code) was made for this project.
- The campus is a best-effort, non-official recreation made for fun. PES University names and signage belong to
  their owners.
