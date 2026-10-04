import * as THREE from 'three';
import { Assets } from './Assets';
import { AudioBridge } from './AudioBridge';
import { Engine } from './Engine';
import { emptyInput, Input, type PlayerInput } from './Input';
import { loadHighScore, loadSettings, QUALITY, saveHighScore, saveSettings, type QualityProfile, type Settings } from './Settings';
import { loadProfile, saveProfile } from './Profile';
import { wakeInterval } from './wakeTimer';
import { CoopClient, CoopHost, type Member } from '../net/Coop';
import { normalizeCode } from '../net/Net';
import type { CtrlMsg, StartSurvivor } from '../net/protocol';
import { CampusBuilder, type CampusBuild } from '../world/Campus';
import { loadWorldTextures, worldUniforms } from '../world/materials';
import { Sky } from '../world/Sky';
import { TreeSystem } from '../world/trees';
import { TrafficSystem } from '../world/traffic';
import { GATES, GLOBE_POS, MAIN_GATE_PORTAL, STATIONS } from '../world/layout';
import { Post } from '../render/Post';
import { CameraRig } from '../render/CameraRig';
import { CharacterManager, WeaponModels } from '../render/Characters';
import { lookColors } from '../render/GlbCharacters';
import { GlbCharacterLibrary } from '../render/GlbCharacters';
import { GrenadeView } from '../render/Grenades';
import { gateInward, stationY, World } from '../sim/World';
import { applyTerrain, setTerrainEnabled, terrainY } from '../world/terrain';
import type { Look, Survivor } from '../sim/actors';
import { CAM_VIEWS } from '../sim/aim';
import { WEAPONS } from '../sim/weapons';
import { Hud } from '../ui/Hud';
import { Menu, type BoardRow, type MenuScreen } from '../ui/Menu';

type GameState = 'loading' | 'menu' | 'playing' | 'paused' | 'gameover';

// Optional modules produced by parallel work streams (loaded if present)
const fxModules = import.meta.glob('../render/Fx.ts');
const propModules = import.meta.glob('../world/Props.ts');

interface FxLike {
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, weapon: string): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3, strength?: number): void;
  impact(point: THREE.Vector3, normal: THREE.Vector3, surface: string): void;
  blood(point: THREE.Vector3, dir: THREE.Vector3, amount?: number, headshot?: boolean): void;
  bloodPool?(pos: THREE.Vector3, scale?: number): void;
  melee?(point: THREE.Vector3, dir: THREE.Vector3): void;
  gateHit?(point: THREE.Vector3): void;
  explosion?(pos: THREE.Vector3, floorY?: number): void;
  shellEject?(pos: THREE.Vector3, right: THREE.Vector3, weapon: string): void;
  update(dt: number): void;
  setNight?(n: number): void;
}

const SQUAD: { name: string; voice: 'male' | 'female'; weapon: 'rifle' | 'smg' | 'shotgun' | 'pistol'; acc: number; look: Look }[] = [
  { name: 'Rahul (CSE, 3rd yr)', voice: 'male', weapon: 'rifle', acc: 0.82, look: { body: 'male', skin: '#8d5a3b', hair: '#1f1712', shirt: '#2f5d9b', pants: '#2b3a55', shoes: '#222222', accessory: '#2d59a8', seed: 21 } },
  { name: 'Ananya (ECE, 2nd yr)', voice: 'female', weapon: 'smg', acc: 0.74, look: { body: 'female', skin: '#b77b52', hair: '#0e0c0b', shirt: '#b3261e', pants: '#f0e6d2', shoes: '#6b4a2e', accessory: '#2d59a8', seed: 33 } },
  { name: 'Manjunath (Security)', voice: 'male', weapon: 'shotgun', acc: 0.66, look: { body: 'male', skin: '#6b3f28', hair: '#161210', shirt: '#26324f', pants: '#1f2430', shoes: '#111111', accessory: '#1d2f6f', seed: 45 } },
];

const _gateX = new THREE.Vector3(1, 0, 0);
const _gateZ = new THREE.Vector3();
const _gateQ = new THREE.Quaternion();
const _camO = new THREE.Vector3();

export class Game {
  engine!: Engine;
  settings: Settings = loadSettings();
  q: QualityProfile = QUALITY[this.settings.quality];
  assets = new Assets();
  sky!: Sky;
  campus!: CampusBuild;
  post!: Post;
  rig!: CameraRig;
  chars!: CharacterManager;
  grenades!: GrenadeView;
  traffic!: TrafficSystem;
  weapons = new WeaponModels();
  charLib = new GlbCharacterLibrary();
  hud!: Hud;
  menu!: Menu;
  input!: Input;
  audio = new AudioBridge();
  fx: FxLike | null = null;
  world: World | null = null;
  state: GameState = 'loading';
  private acc = 0;
  private readonly fixed = 1 / 60;
  private last = performance.now();
  private inputs = new Map<number, PlayerInput>();
  private pin = emptyInput();
  private menuT = 0;
  private detach: (() => void)[] = [];
  private pickupMeshes = new Map<number, THREE.Object3D>();
  private pickupGeo = { ammo: new THREE.BoxGeometry(0.5, 0.3, 0.3), health: new THREE.BoxGeometry(0.4, 0.3, 0.2) };
  private pickupMat = { ammo: new THREE.MeshStandardMaterial({ color: 0x556b2f, emissive: 0x3a4a10, emissiveIntensity: 0.6 }), health: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, emissive: 0xaa2020, emissiveIntensity: 0.5 }) };
  private gateAnim = new Map<string, number>();
  /** Walkable ramps/stairs/podiums/decks with layered navigation (see World.levels). ?flat falls back to the old flat sim. */
  readonly multiLevel = !new URLSearchParams(location.search).has('flat');
  private lastTod = -1;
  private stationMarkers: THREE.InstancedMesh | null = null;
  private clickHint: HTMLElement | null = null;
  /** the player's name + character look (character screen) */
  profile = loadProfile();
  /** co-op session (hosting or joined), null in solo */
  coop: CoopHost | CoopClient | null = null;
  private joinCode = '';
  private rafId = 0;
  private hiddenTicker: (() => void) | null = null;
  private clientStatus = '';
  private joinFailures = 0;
  private preview: { root: THREE.Object3D; mixer: THREE.AnimationMixer; key: string } | null = null;

  async boot(): Promise<void> {
    (window as unknown as { game: Game }).game = this;
    const ui = document.getElementById('ui')!;
    this.engine = new Engine(document.getElementById('app')!, this.q, this.settings.fov);
    this.assets.maxAnisotropy = Math.min(8, this.engine.renderer.capabilities.getMaxAnisotropy());
    this.menu = new Menu(ui, this.settings, {
      onPlay: () => this.startGame(),
      onResume: () => this.resume(),
      onQuitToMenu: () => this.quitToMenu(),
      onRestart: () => {
        if (this.coop?.role === 'host') { this.teardownWorld(); this.startCoopGame(); return; }
        this.quitToMenu(); this.startGame();
      },
      onSettings: (s) => this.applySettings(s),
      onProfile: (p) => { saveProfile(p); this.updatePreview(); },
      onScreen: (sc) => this.onMenuScreen(sc),
      onHost: () => this.hostRoom(),
      onJoin: (code) => this.joinRoom(code),
      onStartCoop: () => this.startCoopGame(),
      onLeaveRoom: () => this.leaveRoom(),
    }, this.profile);
    this.menu.show('loading');
    this.hud = new Hud(ui);
    this.input = new Input(this.engine.renderer.domElement);
    this.input.onPause = () => { if (this.state === 'playing') this.pause(); else if (this.state === 'paused' && this.menu.current === 'pause') this.resume(); };
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing') this.pause();
      if (this.clickHint) this.clickHint.style.display = locked || this.state !== 'playing' ? 'none' : 'block';
    };
    this.engine.renderer.domElement.addEventListener('click', () => { if (this.state === 'playing' && !this.input.locked) this.input.requestLock(); });
    window.addEventListener('keydown', (e) => {
      if (this.state !== 'playing' || !this.world) return;
      if (e.code === 'KeyN' && this.coop?.role !== 'client') this.world.skipPrep();
      if (e.code === 'KeyC') this.rig.shoulderSide *= -1;
      if (e.code === 'KeyT') this.rig.view = (this.rig.view + 1) % CAM_VIEWS.length;
    });
    this.applySettings(this.settings, false);

    let stage = 'Loading textures';
    this.assets.onProgress = (d, t) => this.menu.setProgress(Math.min(0.6, (d / Math.max(1, t)) * 0.6), `${stage}…`);
    const tex = await loadWorldTextures(this.assets);
    stage = 'Loading models';
    await this.weapons.load(this.assets);
    await this.charLib.load(this.assets);
    this.menu.setProgress(0.62, 'Building the campus…');
    await nextFrame();
    setTerrainEnabled(this.multiLevel); // the legacy flat sim (?flat) keeps the whole campus at y = 0
    const trees = new TreeSystem(tex.bark);
    const builder = new CampusBuilder(tex, trees, this.q);
    this.campus = builder.build();
    for (const [id, g] of this.campus.gates) this.gateBase(id, g.panels);
    this.engine.scene.add(this.campus.group);
    this.menu.setProgress(0.75, 'Dressing the set…');
    await nextFrame();
    const propLoader = Object.values(propModules)[0];
    let propsGroup: THREE.Object3D | null = null;
    if (propLoader) {
      try {
        const mod = (await propLoader()) as { buildProps?: (...a: unknown[]) => Promise<{ group: THREE.Group }> };
        if (mod.buildProps) {
          const pb = await mod.buildProps(this.assets, this.campus.collision, { quality: this.q, medianPts: builder.medianPts });
          this.engine.scene.add(pb.group);
          propsGroup = pb.group;
        }
      } catch (err) { console.warn('[props] failed, continuing without', err); }
    }
    // lift the flat-authored campus onto its terrain (the slope from the main gate down to GJB), before any nav graph
    const ts = applyTerrain({ roots: [this.campus.group, ...(propsGroup ? [propsGroup] : [])], collision: this.campus.collision, hooks: [trees], edgeGroup: this.campus.group });
    if (ts.ms) console.info(`[terrain] lifted ${ts.meshes} meshes (${ts.verts} verts, +${ts.added} from subdivision) in ${ts.ms} ms`);
    for (const [, g] of this.campus.gates) g.panels.forEach((p, i) => g.closedPos[i].copy(p.position)); // gates slide from where they now stand
    this.menu.setProgress(0.9, 'Adding traffic…');
    this.traffic = await TrafficSystem.create(this.assets, this.q, this.multiLevel);
    this.engine.scene.add(this.traffic.group);
    this.menu.setProgress(0.93, 'Lighting…');
    this.sky = new Sky(this.engine.renderer, this.engine.scene, this.q.shadowMapSize, this.q.shadowDistance, { low: 4, medium: 6, high: 8, ultra: 10 }[this.settings.quality], { low: 0.35, medium: 0.42, high: 0.5, ultra: 0.6 }[this.settings.quality]);
    this.sky.setTime(0.02);
    this.post = new Post(this.engine.renderer, this.engine.scene, this.engine.camera, this.q);
    this.engine.onResize = (w, h) => this.post.setSize(w, h);
    this.engine.resize();
    this.rig = new CameraRig(this.engine.camera, this.campus.collision);
    this.rig.baseFov = this.settings.fov;
    this.chars = new CharacterManager(this.engine.scene, this.weapons, this.q, this.charLib);
    this.chars.outline = this.post.outline.selection;
    this.grenades = new GrenadeView(this.engine.scene);
    const fxLoader = Object.values(fxModules)[0];
    if (fxLoader) {
      try {
        const mod = (await fxLoader()) as { Fx?: new (s: THREE.Scene, c: THREE.Camera, q: QualityProfile) => FxLike };
        if (mod.Fx) this.fx = new mod.Fx(this.engine.scene, this.engine.camera, this.q);
      } catch (err) { console.warn('[fx] failed, continuing without', err); }
    }
    this.buildStationMarkers();
    this.menu.setProgress(0.95, 'Warming up shaders…');
    this.menuCamera(0);
    // The outline's mask pass draws only the selection layer. Without the lights on it, the renderer's light state
    // changes twice a frame, and every lit material redoes its program lookup in the next main pass.
    this.engine.scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(this.post.outline.selection.layer); });
    this.warmShaders();
    this.menu.setProgress(1, 'Ready');
    this.state = 'menu';
    this.menu.show('main');
    (window as unknown as { game: Game }).game = this;
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
    // a co-op host keeps simulating (and streaming to its players) while its tab is hidden, where rAF stops
    document.addEventListener('visibilitychange', () => this.updateHiddenTicker());
  }

  private frame = (t: number): void => { this.rafId = 0; this.loop(t); };

  private updateHiddenTicker(): void {
    const want = document.hidden && this.coop?.role === 'host' && !!this.world;
    if (want && !this.hiddenTicker) {
      this.hiddenTicker = wakeInterval(16, () => { if (document.hidden) this.loop(performance.now()); });
    } else if (!want && this.hiddenTicker) {
      this.hiddenTicker();
      this.hiddenTicker = null;
      this.last = performance.now();
    }
  }

  /**
   * Compile every program play will need before the first frame. A program's cache key includes the output colour
   * space of the bound render target, and the scene is only ever drawn into the composer's buffers, so compile with
   * one of them bound. Stand-ins cover what only exists in play (characters, the transparent corpse-fade copy of
   * their material, weapons, pickups). compile() skips the shadow-depth and outline variants, so one frame is also
   * drawn with frustum culling off and the stand-in outlined: every object reaches every pass once. A second frame
   * covers the shadow-depth variants built after an outline frame. The renderer draws shadows before it sets up the
   * frame's lights, so their key carries the light count of the previous render, and the outline mask pass renders
   * only the selection layer, which holds no lights. The stand-in materials are never disposed: their programs stay
   * referenced after the last corpse's private material is disposed, so the next death does not recompile.
   */
  private warmShaders(): void {
    const { renderer, scene, camera } = this.engine;
    const warm = new THREE.Group();
    const outlined: THREE.Object3D[] = [];
    if (this.charLib.ready) {
      for (const corpse of [false, true]) {
        const { root, mesh } = this.charLib.instantiate('male', this.charLib.variant('male', {}));
        if (corpse) {
          const m = (mesh.material as THREE.Material).clone();
          m.transparent = true;
          m.depthWrite = false;
          mesh.material = m;
        } else outlined.push(mesh);
        warm.add(root);
      }
    }
    for (const id of ['pistol', 'smg', 'rifle', 'shotgun', 'bat'] as const) warm.add(this.weapons.create(id));
    for (const k of ['ammo', 'health'] as const) warm.add(new THREE.Mesh(this.pickupGeo[k], this.pickupMat[k]));
    // far below the ground, so the warm-up frame shows nothing extra
    warm.position.y = -1000;
    warm.traverse((o) => { o.castShadow = true; });
    scene.add(warm);
    this.grenades.prewarm(true);
    renderer.setRenderTarget(this.post.composer.inputBuffer);
    renderer.compile(scene, camera);
    renderer.setRenderTarget(null);
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    for (const o of outlined) this.post.outline.selection.add(o);
    this.sky.follow(camera.position);
    this.sky.prepare(camera);
    this.post.render(0, 0);
    this.post.render(0, 0);
    for (const o of outlined) this.post.outline.selection.delete(o);
    for (const o of culled) o.frustumCulled = true;
    warm.removeFromParent();
    this.grenades.prewarm(false);
  }

  // -----------------------------------------------------------------------------------------------
  private applySettings(s: Settings, persist = true): void {
    this.settings = s;
    if (persist) saveSettings(s);
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    if (this.rig) this.rig.baseFov = s.fov;
    this.hud.showFps = s.showFps;
    if (this.audio.ready) {
      this.audio.audio.setMasterVolume(s.masterVolume);
      this.audio.audio.setMusicVolume(s.musicVolume);
      this.audio.audio.setSfxVolume(s.sfxVolume);
      this.audio.audio.setVoiceVolume(s.npcVoices ? 1 : 0);
    }
  }

  /** A fresh World for solo, co-op host or co-op client (a client only mirrors the host's). */
  private prepareWorld(role: 'solo' | 'host' | 'client', difficulty: number): World {
    if (!this.audio.ready) {
      this.audio.init().then(() => this.applySettings(this.settings, false)).catch((e) => console.warn('[audio] init failed', e));
    }
    this.clearPreview();
    // reset collision state of gates (in case of restart)
    for (const [, g] of this.campus.gates) g.prismIds.forEach((id) => this.campus.collision.setPrismEnabled(id, true));
    const world = new World(this.campus.collision, { maxZombies: this.q.maxZombies, difficulty, multiLevel: this.multiLevel, role });
    const gp = new Map<string, number[]>();
    for (const [id, g] of this.campus.gates) gp.set(id, g.prismIds);
    world.init(gp);
    return world;
  }

  /** Hook a prepared World (players added) up to the camera, input, HUD, audio and FX, and start playing. */
  private enterWorld(world: World): void {
    this.world = world;
    const me = world.player;
    this.input.yaw = me?.yaw ?? 0;
    this.input.pitch = -0.05;
    this.input.resetRecoil();
    this.acc = 0;
    this.detach.push(this.audio.attach(world));
    this.hud.coop = this.coop ? { rtt: (id) => (this.coop?.role === 'host' ? this.coop.rttOf(id) : this.coop?.rtt.get(id)) } : null;
    this.hud.attach(world);
    this.attachFx(world);
    world.events.on('gameOver', (e) => this.onGameOver(e.wave));
    world.events.on('playerDamaged', (e) => {
      if (e.playerId !== world.localPlayerId) return;
      this.rig.addShake(Math.min(0.6, e.amount / 40));
      this.post.hit(Math.min(1, e.amount / 30));
    });
    this.hud.show(true);
    this.menu.show('none');
    this.state = 'playing';
    this.input.requestLock();
    if (!this.clickHint) {
      this.clickHint = document.createElement('div');
      this.clickHint.className = 'click-to-play';
      this.clickHint.textContent = 'Click to capture the mouse';
      document.getElementById('ui')!.append(this.clickHint);
    }
    this.clickHint.style.display = 'none';
    this.updateHiddenTicker();
  }

  private async startGame(): Promise<void> {
    const world = this.prepareWorld('solo', 1);
    world.addPlayer(this.profile.name, this.profile.look);
    SQUAD.forEach((m, i) => world.addNpc(m.name, m.voice, m.look, m.weapon, i, m.acc));
    this.menu.coopRole = null;
    this.enterWorld(world);
    world.startGame();
  }

  // -----------------------------------------------------------------------------------------------
  // Co-op
  // -----------------------------------------------------------------------------------------------
  private hostRoom(): void {
    this.leaveRoom(false);
    this.joinFailures = 0;
    const host = new CoopHost(this.profile, {
      onReady: () => this.refreshLobby(),
      onStatus: (st) => {
        this.refreshLobby();
        if (this.world) this.hud.message(st ? 'Matchmaking server lost — reconnecting (players in the game are fine)' : 'Matchmaking server back: new players can join', st ? 'warn' : 'info');
      },
      onRoster: () => this.refreshLobby(),
      onJoinFailed: () => {
        this.joinFailures++;
        this.refreshLobby();
        if (this.world) this.hud.message("A player couldn't connect: no network path between you (they can try again; a relay server fixes this — see README)", 'warn');
      },
      onError: (msg) => { this.leaveRoom(false); this.menu.coopFailed(msg); },
      onJoinInGame: (m) => this.hostAddMember(m),
      onLeaveInGame: (m) => {
        this.world?.removeSurvivor(m.survivorId);
        this.inputs.delete(m.survivorId);
        this.hud.message(`${m.profile.name} left the game.`, 'info');
        this.retuneDifficulty();
      },
    });
    this.coop = host;
    this.refreshLobby();
  }

  private joinRoom(code: string): void {
    this.leaveRoom(false);
    this.joinCode = normalizeCode(code);
    const fail = (msg: string) => { this.leaveRoom(false); this.menu.coopFailed(msg); };
    this.clientStatus = '';
    this.coop = new CoopClient(this.joinCode, this.profile, {
      onRoster: () => this.refreshLobby(),
      onStatus: (st) => { this.clientStatus = st; this.refreshLobby(); },
      onStart: (msg) => this.clientStart(msg),
      onJoin: (ss) => { this.world?.addMirrorSurvivor(ss.id, ss.kind, ss.name, ss.voice, ss.look); if (this.world) this.hud.message(`${ss.name} joined the game.`, 'info'); },
      onLeave: (id) => {
        const s = this.world?.survivors.find((q) => q.id === id);
        if (s) this.hud.message(`${s.name} left the game.`, 'info');
        this.world?.removeSurvivor(id);
      },
      onEnd: (reason) => fail(reason),
    }, fail);
    this.refreshLobby();
  }

  private refreshLobby(): void {
    const c = this.coop;
    if (!c) { this.menu.setLobby(null); return; }
    const failed = this.joinFailures ? ` · ${this.joinFailures} join attempt${this.joinFailures > 1 ? 's' : ''} couldn't connect (no network path between you and them — they can retry; see README for a relay server)` : '';
    if (c.role === 'host') this.menu.setLobby({ role: 'host', code: c.code, players: c.roster(), status: (c.net.status || (c.code ? 'Share the code with your friends, then press Start.' : 'Contacting the matchmaking server…')) + failed, inGame: c.inGame });
    else this.menu.setLobby({ role: 'client', code: this.joinCode, players: c.roster, status: c.link ? (this.clientStatus.startsWith('Connected') ? this.clientStatus : '') : this.clientStatus || 'Connecting…', inGame: false });
  }

  /** Co-op has no AI squad: zombie strength follows the head count (coopDifficulty). */
  private retuneDifficulty(): void {
    const w = this.world;
    if (!w || this.coop?.role !== 'host') return;
    const d = coopDifficulty(w.survivors.filter((q) => q.kind === 'player').length);
    w.opts.difficulty = d.count;
    w.opts.hpDifficulty = d.hp;
  }

  private startCoopGame(): void {
    const host = this.coop;
    if (!host || host.role !== 'host' || !host.code) return;
    const n = 1 + host.members.size;
    const d = coopDifficulty(n);
    const world = this.prepareWorld('host', d.count);
    world.opts.hpDifficulty = d.hp;
    const entry = (s: Survivor, peer?: string): StartSurvivor => ({ id: s.id, kind: s.kind === 'npc' ? 'npc' : 'player', name: s.name, look: s.look, voice: s.voice, peer });
    const list: StartSurvivor[] = [entry(world.addPlayer(this.profile.name, this.profile.look), 'host')];
    for (const m of host.members.values()) {
      const s = world.addPlayer(m.profile.name, m.profile.look);
      m.survivorId = s.id;
      list.push(entry(s, m.peer));
    }
    host.beginGame(world, list, d.count, this.q.maxZombies);
    this.menu.coopRole = 'host';
    this.enterWorld(world);
    world.startGame();
  }

  private hostAddMember(m: Member): StartSurvivor | null {
    const w = this.world;
    if (!w) return null;
    const s = w.addPlayer(m.profile.name, m.profile.look);
    w.placeNearTeam(s);
    this.retuneDifficulty();
    this.hud.message(`${s.name} joined the game.`, 'info');
    return { id: s.id, kind: 'player', name: s.name, look: s.look, voice: s.voice, peer: m.peer };
  }

  private clientStart(msg: Extract<CtrlMsg, { t: 'start' }>): void {
    const client = this.coop;
    if (!client || client.role !== 'client') return;
    if (this.world) this.teardownWorld();
    const world = this.prepareWorld('client', msg.difficulty);
    for (const ss of msg.survivors) world.addMirrorSurvivor(ss.id, ss.kind, ss.name, ss.voice, ss.look);
    world.localPlayerId = msg.yourId;
    client.beginGame(world);
    this.menu.coopRole = 'client';
    this.enterWorld(world);
  }

  /** Leave co-op entirely (close the room when hosting). */
  private leaveRoom(showMenu = true): void {
    const inGame = !!this.world;
    if (this.world) this.teardownWorld();
    this.coop?.destroy();
    this.coop = null;
    this.menu.coopRole = null;
    this.menu.setLobby(null);
    this.updateHiddenTicker();
    if (inGame || showMenu) { this.state = 'menu'; this.hud.show(false); this.input.exitLock(); }
    if (showMenu) this.menu.show('main');
  }

  private attachFx(world: World): void {
    const ev = world.events;
    const off: (() => void)[] = [];
    const muzzleWorld = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let lastRecoilT = -1; // a shotgun trigger pull emits several local 'shot' events in one tick; kick once
    off.push(ev.on('shot', (e) => {
      // a co-op client drew its own shots already (World.predictShot): skip the host's echo of them
      if (world.role === 'client' && e.shooterId === world.localPlayerId && !e.predicted) return;
      // recoil moves the aim, so it must not depend on the FX module having loaded
      if (e.shooterId === world.localPlayerId && (e.predicted || world.time !== lastRecoilT)) {
        lastRecoilT = world.time;
        this.input.addRecoil(WEAPONS[e.weapon as keyof typeof WEAPONS]?.recoil ?? 0.02, world.player!.aiming);
      }
      if (!this.fx) return;
      const v = this.chars.view(e.shooterId);
      if (v?.muzzle) v.muzzle.getWorldPosition(muzzleWorld); else muzzleWorld.copy(e.origin);
      dir.copy(e.end).sub(muzzleWorld).normalize();
      this.fx.muzzleFlash(muzzleWorld, dir, e.weapon);
      this.fx.tracer(muzzleWorld, e.end, e.weapon === 'shotgun' ? 0.6 : 1);
      if (e.weapon !== 'shotgun') {
        const right = new THREE.Vector3(dir.z, 0, -dir.x).normalize().negate();
        this.fx.shellEject?.(muzzleWorld.clone().addScaledVector(dir, -0.35), right, e.weapon);
      }
    }));
    off.push(ev.on('impact', (e) => this.fx?.impact(e.point, e.normal, e.surface)));
    off.push(ev.on('hit', (e) => {
      if (!this.fx || e.surface !== 'flesh') return;
      const d = e.normal.clone().negate();
      const shooter = world.survivors.find((s) => s.id === e.attackerId);
      if (shooter?.def.kind === 'melee') this.fx.melee?.(e.point, d) ?? this.fx.blood(e.point, d, 1.5, false);
      else this.fx.blood(e.point, d, e.headshot ? 1.6 : 1, e.headshot);
    }));
    off.push(ev.on('death', (e) => { if (e.kind === 'zombie') setTimeout(() => this.fx?.bloodPool?.(e.position, 0.8 + Math.random() * 0.5), 700); }));
    off.push(ev.on('gateHit', (e) => this.fx?.gateHit?.(e.position.clone().setY(1.2))));
    off.push(ev.on('grenadeExplode', (e) => {
      this.fx?.explosion?.(e.position, e.floorY);
      // shake by distance from the camera: a jolt up close, a rumble across the quad
      const d = e.position.distanceTo(this.engine.camera.position);
      this.rig.addShake(THREE.MathUtils.clamp(1.15 - d / 28, 0, 1.1));
    }));
    this.detach.push(() => off.forEach((o) => o()));
  }

  private onGameOver(wave: number): void {
    const w = this.world;
    const me = w?.player;
    if (!w || !me) return;
    const kills = me.kills;
    let board: BoardRow[] | null = null;
    let points = w.points.get(me.id) ?? 0;
    if (this.coop) {
      points = w.score.get(me.id) ?? 0;
      board = w.survivors.filter((s) => s.kind === 'player')
        .map((s) => ({ name: s.name, score: w.score.get(s.id) ?? 0, kills: s.kills, you: s.id === me.id, color: s.look.shirt }))
        .sort((a, b) => b.score - a.score || b.kills - a.kills);
    } else {
      const hs = loadHighScore();
      if (!hs || wave > hs.wave || (wave === hs.wave && points > hs.points)) saveHighScore({ wave, kills, points });
    }
    setTimeout(() => {
      if (this.world !== w) return;
      this.state = 'gameover';
      this.input.exitLock();
      this.hud.show(false);
      this.menu.gameOver(wave, kills, points, board);
    }, 2500);
  }

  private pause(): void {
    this.state = 'paused';
    this.input.exitLock();
    this.menu.show('pause');
  }

  private resume(): void {
    this.menu.show('none');
    this.state = 'playing';
    this.input.requestLock();
    this.last = performance.now();
  }

  /** Pause-menu / game-over "quit": solo returns to the menu; in co-op it leaves (or, hosting, closes) the room. */
  private quitToMenu(): void {
    if (this.coop) { this.leaveRoom(); return; }
    this.teardownWorld();
    this.hud.show(false);
    this.state = 'menu';
    this.input.exitLock();
    this.menu.show('main');
  }

  /** Drop the current World and everything hooked to it (views, listeners, pickups, gate poses). */
  private teardownWorld(): void {
    this.coop?.endGame();
    this.detach.forEach((d) => d());
    this.detach = [];
    if (this.world) {
      this.world.nav && (this.world as unknown as { nav: { worker?: Worker } }).nav;
      for (const [, m] of this.pickupMeshes) m.removeFromParent();
      this.pickupMeshes.clear();
    }
    this.world = null;
    this.chars.sync({ survivors: [], zombies: [] } as unknown as World, 1, 0, this.engine.camera.position);
    this.grenades.update(null, 1, 0);
    // restore gates visually
    for (const [id] of this.campus.gates) {
      this.poseGate(id, 0);
      this.gateAnim.set(id, 0);
    }
    this.inputs.clear();
    this.updateHiddenTicker();
  }

  // -----------------------------------------------------------------------------------------------
  private loop = (now: number = performance.now()): void => {
    // the rAF timestamp is the frame's start time; performance.now() here would add the callback's scheduling
    // jitter to dt, and with it to the fixed-step count and the interpolation alpha. `last` can be a later
    // performance.now() (boot, resume), hence the clamp at 0. Direct calls without a timestamp (the cinematic
    // capture tool steps the game with a fake performance.now) fall back to the clock.
    const dt = Math.min(0.1, Math.max(0, now - this.last) / 1000);
    this.last = now;
    worldUniforms.uTime.value += dt;
    const e = this.engine;
    e.renderer.info.reset();
    const w = this.world;
    this.traffic?.update(dt, e.camera);
    if (w) w.setTraffic(this.traffic.obstacles);
    const host = this.coop?.role === 'host' ? this.coop : null;
    const client = this.coop?.role === 'client' ? this.coop : null;
    // co-op can't pause: behind the pause menu the game keeps running (with no input from this player)
    const ticking = this.state === 'playing' || (!!this.coop && this.state === 'paused');
    const headless = document.hidden; // hidden co-op host: simulate and stream, draw nothing
    if (w && (ticking || this.state === 'gameover')) {
      if (ticking) {
        this.acc += dt;
        this.input.updateRecoil(dt);
        let first = true;
        let steps = 0;
        while (this.acc >= this.fixed && steps < 5) {
          this.input.sample(this.pin, first);
          if (!this.input.locked || this.state !== 'playing') { this.pin.fire = false; this.pin.aim = false; this.pin.moveX = this.pin.moveZ = 0; }
          const driving = w.player ? this.traffic?.drive(w.player.id, w.player, this.pin, this.fixed) ?? false : false;
          if (driving) {
            this.pin.moveX = this.pin.moveZ = 0;
            this.pin.fire = this.pin.aim = false;
            this.pin.interact = this.pin.interactPressed = this.pin.command = false;
          }
          if (this.pin.command && !this.coop) w.toggleNpcMode(); // co-op has no AI squad
          // aim from where this frame's render camera will be: the last frame's rig offset moved to the player's
          // position at the start of this tick, plus the share of the tick's movement the interpolated render shows
          // (all of it for a tick that isn't the frame's last; none after the 5-step clamp zeroes acc)
          const rest = this.acc - this.fixed;
          this.pin.camAlpha = steps === 4 ? 0 : rest < this.fixed ? rest / this.fixed : 1;
          this.rig.aimOrigin(w.player!.pos, this.pin.yaw, this.pin.pitch, _camO);
          this.pin.camX = _camO.x; this.pin.camY = _camO.y; this.pin.camZ = _camO.z;
          if (client) {
            // our own movement runs here (no lag); the host takes the pose, everything else comes back in snapshots
            if (client.ready) {
              w.predictLocal(this.fixed, this.pin);
              w.predictShot(this.fixed, this.pin);
              client.sendInput(this.pin, w.player!, !!w.player!.mantle);
            }
          } else {
            this.inputs.set(w.localPlayerId, this.pin);
            host?.fillInputs(this.inputs);
            w.update(this.fixed, this.inputs);
            host?.afterTick(w);
          }
          this.pin.command = false;
          first = false;
          this.acc -= this.fixed;
          steps++;
        }
        if (steps === 5) this.acc = 0;
      } else if (!client) {
        w.update(dt, new Map());
        host?.afterTick(w);
      }
      client?.interpolate(dt);
    }
    if (headless) { if (!this.rafId) this.rafId = requestAnimationFrame(this.frame); return; }
    if (w && (ticking || this.state === 'gameover')) {
      const alpha = this.acc / this.fixed;
      const me = w.player!;
      // co-op: while dead, watch a living teammate until the wave ends
      const p = me.alive || !this.coop ? me : (w.survivors.find((s) => s.kind === 'player' && s.alive) ?? me);
      this.chars.sync(w, alpha, dt, e.camera.position);
      this.grenades.update(w, alpha, dt);
      const pp = new THREE.Vector3().lerpVectors(p.prev, p.pos, p === me ? alpha : 1);
      const sprinting = this.pin.sprint && this.pin.moveZ > 0 && Math.hypot(p.vel.x, p.vel.z) > 5;
      this.rig.update(dt, pp, this.input.yaw, this.input.pitch, p === me && p.aiming && !p.downed, sprinting, p.downed);
      this.updateGates(dt, w);
      this.updatePickups(dt, w);
      this.audio.update(dt, w, e.camera);
      this.hud.update(dt, w, e.camera, this.input.yaw);
      this.sky.follow(pp);
      this.setTime(w.timeOfDay);
      this.fx?.update(dt);
      this.sky.prepare(this.engine.camera);
      this.post.render(dt, me.alive ? THREE.MathUtils.clamp(1 - me.health / 40, 0, 1) : p !== me ? 0.35 : 1);
    } else {
      this.menuT += dt;
      if (this.preview) this.previewCamera(); else this.menuCamera(this.menuT);
      this.sky.follow(this.engine.camera.position);
      this.setTime(0.06);
      this.fx?.update(dt);
      this.sky.prepare(this.engine.camera);
      this.post.render(dt, 0);
    }
    for (const u of this.campus.updatables) u(dt, this.lastTod);
    this.pulseStations();
    this.preview?.mixer.update(dt);
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frame);
  };

  /** Debug/testing: advance the simulation synchronously (works in background tabs). */
  debugStep(seconds: number, input?: Partial<PlayerInput>): void {
    const w = this.world;
    if (!w) return;
    const steps = Math.round(seconds / this.fixed);
    const pin = { ...emptyInput(), yaw: this.input.yaw, pitch: this.input.pitch, ...input };
    for (let i = 0; i < steps; i++) {
      this.inputs.set(w.localPlayerId, pin);
      w.update(this.fixed, this.inputs);
      pin.reload = pin.jump = pin.melee = pin.interactPressed = pin.grenade = false;
      pin.weaponSlot = -1;
    }
  }

  private setTime(t: number): void {
    if (Math.abs(t - this.lastTod) < 0.002) return;
    this.lastTod = t;
    this.sky.setTime(t);
    // time-of-day exposure (dusk/night lift) at 60% of the keyframe curve: keeps the mood, keeps nights readable
    this.post.setExposure(1 + (this.sky.exposure - 1) * 0.6);
    this.post.setNight(worldUniforms.uNight.value);
    this.fx?.setNight?.(worldUniforms.uNight.value);
  }

  // -----------------------------------------------------------------------------------------------
  // Character screen: the chosen look, standing on the entry road in front of a fixed camera
  // -----------------------------------------------------------------------------------------------
  private static readonly PREVIEW_AT = new THREE.Vector3(124.5, 0, -118.5);

  private onMenuScreen(sc: MenuScreen): void {
    if (sc === 'character') this.updatePreview();
    else this.clearPreview();
  }

  private clearPreview(): void {
    if (!this.preview) return;
    this.preview.mixer.stopAllAction();
    this.preview.root.removeFromParent();
    this.preview = null;
  }

  private updatePreview(): void {
    if (this.menu.current !== 'character' || !this.charLib.ready) return;
    const look = this.profile.look;
    const key = look.body;
    const geo = this.charLib.variant(key, lookColors(look, false));
    const prev = this.preview;
    if (prev && prev.key === key) {
      prev.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).geometry = geo; });
      return;
    }
    this.clearPreview();
    const { root, template } = this.charLib.instantiate(key, geo);
    const holder = new THREE.Group();
    holder.add(root);
    const at = Game.PREVIEW_AT;
    holder.position.set(at.x, this.multiLevel ? terrainY(at.x, at.z) : 0, at.z);
    holder.rotation.y = 0.35;
    holder.scale.setScalar((key === 'female' ? 1.62 : 1.75) / Math.max(0.1, template.height));
    holder.traverse((o) => { o.castShadow = true; });
    const mixer = new THREE.AnimationMixer(root);
    const idle = template.clips.get('Idle') ?? [...template.clips.values()][0];
    if (idle) mixer.clipAction(idle).play();
    this.engine.scene.add(holder);
    this.preview = { root: holder, mixer, key };
  }

  private previewCamera(): void {
    const cam = this.engine.camera;
    const at = this.preview!.root.position;
    // the menu panel covers the left of the screen: frame the body at ~45% right of centre, whatever the aspect
    if (Math.abs(cam.fov - 40) > 0.1) { cam.fov = 40; cam.updateProjectionMatrix(); }
    const d = 3.8;
    const off = Math.tan(THREE.MathUtils.degToRad(20)) * d * cam.aspect * 0.45;
    cam.position.set(at.x - off, at.y + 1.35, at.z + d);
    cam.lookAt(at.x - off, at.y + 1.0, at.z);
  }

  private menuCamera(t: number): void {
    // slow cinematic drift along the entry road toward the gate and globe
    const cam = this.engine.camera;
    // high sweep over the entry road: gate + mural on one side, globe plaza + MRD on the other
    const a = t * 0.03;
    const cx = 132 + Math.sin(a) * 22, cz = -104 + Math.cos(a * 0.8) * 8;
    cam.position.set(cx, 19 + Math.sin(a * 1.3) * 2.5, cz);
    const gate = new THREE.Vector3(MAIN_GATE_PORTAL.x, 5, -128);
    const globe = new THREE.Vector3(GLOBE_POS[0], 4, GLOBE_POS[1]);
    cam.lookAt(gate.lerp(globe, 0.5 + Math.sin(a * 0.7) * 0.45));
    if (Math.abs(cam.fov - 55) > 0.1) { cam.fov = 55; cam.updateProjectionMatrix(); }
  }

  /** Base (closed) orientation of every gate leaf, captured once at boot: the animation always starts from it. */
  private gateBaseQuat = new Map<string, THREE.Quaternion[]>();

  private gateBase(id: string, panels: THREE.Object3D[]): THREE.Quaternion[] {
    let q = this.gateBaseQuat.get(id);
    if (!q) this.gateBaseQuat.set(id, (q = panels.map((p) => p.quaternion.clone())));
    return q;
  }

  /** Pose the gate leaves from scratch: cur 0 = shut, 1 = knocked flat toward the campus. */
  private poseGate(id: string, cur: number, shake = 0): void {
    const vis = this.campus.gates.get(id);
    const def = GATES.find((g) => g.id === id);
    if (!vis || !def) return;
    const base = this.gateBase(id, vis.panels);
    const [ix, iz] = gateInward(def.a, def.b);
    vis.panels.forEach((panel, i) => {
      const fall = cur * (Math.PI / 2 - 0.05) * (i % 2 ? 1 : 0.92);
      // the leaf's local +Z after its base yaw decides which way a +X tilt topples it; always topple inward
      _gateZ.set(0, 0, 1).applyQuaternion(base[i]);
      const sign = _gateZ.x * ix + _gateZ.z * iz >= 0 ? 1 : -1;
      panel.quaternion.copy(base[i]).multiply(_gateQ.setFromAxisAngle(_gateX, sign * fall));
      panel.position.copy(vis.closedPos[i]);
      panel.position.x += ix * (Math.sin(fall) * 1.1) + shake;
      panel.position.z += iz * (Math.sin(fall) * 1.1);
    });
  }

  private updateGates(dt: number, w: World): void {
    for (const g of w.gates) {
      const target = g.broken ? 1 : 0;
      let cur = this.gateAnim.get(g.id) ?? 0;
      cur += (target - cur) * Math.min(1, dt * (g.broken ? 3 : 5));
      if (Math.abs(target - cur) < 1e-3) cur = target;
      this.gateAnim.set(g.id, cur);
      const shake = !g.broken && w.time - g.lastHitT < 0.15 ? (Math.random() - 0.5) * 0.04 : 0;
      this.poseGate(g.id, cur, shake);
    }
  }

  private updatePickups(dt: number, w: World): void {
    const seen = new Set<number>();
    for (const pk of w.pickups) {
      seen.add(pk.id);
      let m = this.pickupMeshes.get(pk.id);
      if (!m) {
        m = new THREE.Mesh(this.pickupGeo[pk.kind], this.pickupMat[pk.kind]);
        m.castShadow = true;
        this.engine.scene.add(m);
        this.pickupMeshes.set(pk.id, m);
      }
      m.position.set(pk.pos.x, pk.pos.y + 0.45 + Math.sin(w.time * 3 + pk.id) * 0.1, pk.pos.z);
      m.rotation.y += dt * 2;
      m.visible = pk.ttl > 5 || Math.sin(w.time * 12) > 0;
    }
    for (const [id, m] of this.pickupMeshes) if (!seen.has(id)) { m.removeFromParent(); this.pickupMeshes.delete(id); }
  }

  private buildStationMarkers(): void {
    const geo = new THREE.RingGeometry(0.75, 0.95, 32).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: false });
    const mesh = new THREE.InstancedMesh(geo, mat, STATIONS.length);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    STATIONS.forEach((s, i) => {
      m4.makeTranslation(s.pos[0], (this.multiLevel ? stationY(s) : 0) + 0.08, s.pos[1]);
      mesh.setMatrixAt(i, m4);
      col.set(s.kind === 'ammo' ? 0xf2b233 : s.kind === 'health' ? 0xe5484d : s.kind === 'grenade' ? 0xb8c46a : 0x46c46e).multiplyScalar(2);
      mesh.setColorAt(i, col);
    });
    mesh.frustumCulled = false;
    this.engine.scene.add(mesh);
    this.stationMarkers = mesh;
  }

  private pulseStations(): void {
    if (!this.stationMarkers) return;
    const m = this.stationMarkers.material as THREE.MeshBasicMaterial;
    m.opacity = 0.45 + Math.sin(performance.now() * 0.004) * 0.25;
  }
}

/**
 * Co-op zombie scaling for n players (no AI squad). Solo's team is the player + 3 AI, so a wave's total zombie health
 * (count × health) is n / 4 of solo's, split between more zombies (f^0.6) and tougher ones (f^0.4).
 */
export function coopDifficulty(n: number): { count: number; hp: number } {
  const f = Math.max(1, n) / 4;
  return { count: Math.pow(f, 0.6), hp: Math.pow(f, 0.4) };
}

function nextFrame(): Promise<void> {
  // rAF never fires in hidden tabs; fall back to a timeout so loading still completes
  return new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 50);
  });
}
