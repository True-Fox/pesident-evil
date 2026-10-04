import { HAIR_COLORS, PANTS_COLORS, SHIRT_COLORS, SHOE_COLORS, SKIN_TONES } from '../core/Profile';
import { loadHighScore, type Quality, type Settings } from '../core/Settings';
import { MAX_PLAYERS, type Profile, type RosterEntry } from '../net/protocol';

export type MenuScreen = 'loading' | 'main' | 'pause' | 'settings' | 'controls' | 'gameover' | 'character' | 'coop' | 'lobby' | 'none';

export interface MenuCallbacks {
  onPlay: () => void;
  onResume: () => void;
  onQuitToMenu: () => void;
  onRestart: () => void;
  onSettings: (s: Settings) => void;
  onProfile: (p: Profile) => void;
  onScreen: (s: MenuScreen) => void;
  onHost: () => void;
  onJoin: (code: string) => void;
  onStartCoop: () => void;
  onLeaveRoom: () => void;
}

/** What the lobby screen shows (set by Game). */
export interface LobbyView {
  role: 'host' | 'client';
  code: string;
  players: RosterEntry[];
  status: string;
  inGame: boolean;
}

/** One leaderboard row (co-op game over). */
export interface BoardRow { name: string; score: number; kills: number; you: boolean; color: string }

const CONTROLS: [string, string][] = [
  ['W A S D', 'Move'], ['Mouse', 'Look / aim'], ['Left click', 'Shoot / swing bat'], ['Right click', 'Aim down sights'],
  ['Shift', 'Sprint'], ['Space', 'Jump'], ['R', 'Reload'], ['E', 'Interact · enter / exit vehicle · buy · revive · repair gate'],
  ['1-4 / wheel', 'Switch weapon'], ['V / Q', 'Quick bat swing'], ['G', 'Throw grenade (lands at the crosshair)'], ['F', 'Squad: hold position / follow me (solo)'], ['C', 'Swap shoulder'],
  ['T', 'Camera: near / far / high'], ['N', 'Start next wave now (solo / co-op host)'], ['Esc / P', 'Pause (co-op: menu, the game keeps running)'],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const TIPS = [
  'Bullets pass through the steel gate bars — shoot them while they bash it.',
  'Headshots are worth extra points. The cricket bat is worth even more.',
  'Hold E at the gate between waves to rebuild it.',
  'Press E near a vehicle to enter or exit it. E also handles revive, repair, and pickups.',
  'Downed friends can be revived. Stand close and hold E.',
  'The canteen stash near South Thindies has an SMG. The NCC armoury by the MRD block has a rifle.',
  'More weapon lockers hide indoors: the admissions hall, the Innovation Lab, GJB, the BE labs, the MRD lobby and the food court.',
  'Later waves come round to the west gate on PES University Road.',
  'Press G to throw a grenade where you aim. Ammo crates restock them — up to four.',
];

export class Menu {
  root = document.createElement('div');
  private screen: MenuScreen = 'none';
  private prev: MenuScreen = 'main';
  private progress = 0;
  private progressLabel = '';
  private goStats = { wave: 0, kills: 0, points: 0 };
  private board: BoardRow[] | null = null;
  private lobby: LobbyView | null = null;
  private joinCode = '';
  private coopError = '';
  /** co-op game running: pause and game-over offer leaving instead of restarting */
  coopRole: 'host' | 'client' | null = null;

  constructor(parent: HTMLElement, private settings: Settings, private cb: MenuCallbacks, private profile: Profile) {
    this.root.className = 'menu';
    parent.append(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('change', (e) => this.onInput(e));
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (e.key !== 'Enter') return;
      if (t.dataset.p === 'code') (this.root.querySelector('button[data-a="join"]') as HTMLButtonElement | null)?.click();
      else if (t.dataset.p === 'name') t.blur();
    });
  }

  get current(): MenuScreen { return this.screen; }

  show(s: MenuScreen): void {
    if (s !== 'settings' && s !== 'controls') this.prev = s;
    this.screen = s;
    this.render();
    this.cb.onScreen(s);
  }

  setLobby(v: LobbyView | null): void {
    this.lobby = v;
    if (this.screen === 'lobby') this.render();
  }

  coopFailed(msg: string): void {
    this.coopError = msg;
    this.lobby = null;
    this.show('coop');
  }

  setProgress(f: number, label: string): void {
    this.progress = f;
    this.progressLabel = label;
    if (this.screen === 'loading') {
      const bar = this.root.querySelector('.m-progress > div') as HTMLElement | null;
      const lab = this.root.querySelector('.m-progress-label') as HTMLElement | null;
      if (bar) bar.style.width = `${Math.round(f * 100)}%`;
      if (lab) lab.textContent = label;
    }
  }

  gameOver(wave: number, kills: number, points: number, board: BoardRow[] | null = null): void {
    this.goStats = { wave, kills, points };
    this.board = board;
    this.show('gameover');
  }

  private title(): string {
    return `<div class="m-title"><div class="m-kicker">PES UNIVERSITY · RING ROAD CAMPUS · BENGALURU</div><h1><span>PES</span>IDENT EVIL</h1></div>`;
  }

  private render(): void {
    const s = this.settings;
    const hs = loadHighScore();
    let html = '';
    switch (this.screen) {
      case 'none': html = ''; break;
      case 'loading':
        html = `<div class="m-panel m-center">${this.title()}
          <div class="m-progress"><div style="width:${Math.round(this.progress * 100)}%"></div></div>
          <div class="m-progress-label">${this.progressLabel}</div>
          <div class="m-tip">${TIPS[Math.floor(Math.random() * TIPS.length)]}</div></div>`;
        break;
      case 'main':
        html = `<div class="m-panel m-left">${this.title()}
          <p class="m-blurb">The evening bell never rang. Something came down the Outer Ring Road, and now it wants in.
          Hold the campus with your friends until dawn — or until the attendance shortage is the least of your problems.</p>
          <div class="m-buttons">
            <button data-a="play" class="primary">Play solo</button>
            <button data-a="coop">Co-op (up to ${MAX_PLAYERS})</button>
            <button data-a="character">Character · ${esc(this.profile.name)}</button>
            <button data-a="settings">Settings</button>
            <button data-a="controls">Controls</button>
          </div>
          ${hs ? `<div class="m-hs">Best: wave ${hs.wave} · ${hs.kills} kills · ${hs.points.toLocaleString('en-IN')} pts</div>` : ''}
          <div class="m-foot">Solo with an AI squad, or co-op with friends (one hosts, peer to peer) · Map data © OpenStreetMap contributors · Textures CC0 Poly Haven</div></div>`;
        break;
      case 'pause':
        html = `<div class="m-panel m-center"><h2>${this.coopRole ? 'Menu' : 'Paused'}</h2>${this.coopRole ? '<div class="m-note">Co-op: the game keeps running while this menu is open.</div>' : ''}<div class="m-buttons">
          <button data-a="resume" class="primary">Resume</button><button data-a="settings">Settings</button>
          <button data-a="controls">Controls</button><button data-a="quit">${this.coopRole === 'host' ? 'End game for everyone' : this.coopRole ? 'Leave game' : 'Quit to menu'}</button></div></div>`;
        break;
      case 'gameover': {
        const g = this.goStats;
        const board = this.board ? `<table class="m-board">${this.board.map((r, i) => `<tr class="${r.you ? 'you' : ''}"><td>${i + 1}</td><td><i style="background:${r.color}"></i>${esc(r.name)}</td><td>${r.score.toLocaleString('en-IN')}</td><td>${r.kills} kills</td></tr>`).join('')}</table>` : '';
        const buttons = this.coopRole === 'host' ? '<button data-a="restart" class="primary">Play again (same room)</button><button data-a="quit">Close room</button>'
          : this.coopRole === 'client' ? '<div class="m-note">Waiting for the host to start another game…</div><button data-a="quit">Leave room</button>'
            : '<button data-a="restart" class="primary">Try again</button><button data-a="quit">Main menu</button>';
        html = `<div class="m-panel m-center m-go"><h2>${this.coopRole ? 'The campus fell' : "You didn't make it"}</h2>
          <div class="m-stats"><div><b>${g.wave}</b><span>waves</span></div><div><b>${g.kills}</b><span>kills</span></div><div><b>${g.points.toLocaleString('en-IN')}</b><span>${this.coopRole ? 'score' : 'points'}</span></div></div>
          ${board}
          ${hs && !this.coopRole ? `<div class="m-hs">Best: wave ${hs.wave} · ${hs.kills} kills</div>` : ''}
          <div class="m-buttons">${buttons}</div></div>`;
        break;
      }
      case 'character': {
        const p = this.profile, L = p.look;
        const row = (key: string, label: string, list: string[], cur: string) =>
          `<div class="m-row"><span>${label}</span><div class="m-sw">${list.map((c) => `<button data-sw="${key}" data-c="${c}" class="${c === cur ? 'on' : ''}" style="background:${c}" aria-label="${label} ${c}"></button>`).join('')}</div></div>`;
        html = `<div class="m-panel m-left m-char"><h2>Your character</h2>
          <div class="m-form">
            <label>Name <input type="text" data-p="name" maxlength="16" value="${esc(p.name)}" spellcheck="false"></label>
            <div class="m-row"><span>Body</span><div class="m-seg"><button data-body="male" class="${L.body === 'male' ? 'on' : ''}">Male</button><button data-body="female" class="${L.body === 'female' ? 'on' : ''}">Female</button></div></div>
            ${row('skin', 'Skin', SKIN_TONES, L.skin)}
            ${row('hair', 'Hair', HAIR_COLORS, L.hair)}
            ${row('shirt', 'T-shirt', SHIRT_COLORS, L.shirt)}
            ${row('pants', 'Trousers', PANTS_COLORS, L.pants)}
            ${row('shoes', 'Shoes', SHOE_COLORS, L.shoes)}
            <div class="m-note">Your name shows over your head and on the leaderboard in co-op.</div>
          </div>
          <div class="m-buttons"><button data-a="back-main" class="primary">Done</button></div></div>`;
        break;
      }
      case 'coop':
        html = `<div class="m-panel m-left"><h2>Co-op</h2>
          <p class="m-blurb">One player hosts and shares a room code; up to ${MAX_PLAYERS} can play. The host's browser runs the game, so the host should have the steadiest connection and machine. Friends join from anywhere — it works peer to peer, no account needed.</p>
          ${this.coopError ? `<div class="m-err">${esc(this.coopError)}</div>` : ''}
          <div class="m-buttons">
            <button data-a="host" class="primary">Host a room</button>
            <div class="m-join"><input type="text" data-p="code" maxlength="5" placeholder="CODE" value="${esc(this.joinCode)}" spellcheck="false" autocomplete="off"><button data-a="join">Join</button></div>
            <button data-a="back-main">Back</button>
          </div>
          <div class="m-note">Playing as <b>${esc(this.profile.name)}</b> — change it under Character.</div></div>`;
        break;
      case 'lobby': {
        const v = this.lobby;
        if (!v) { html = '<div class="m-panel m-center"><h2>Connecting…</h2></div>'; break; }
        const n = v.players.length;
        const f = Math.max(1, n) / 4;
        html = `<div class="m-panel m-left"><h2>${v.role === 'host' ? 'Your room' : 'Room'}</h2>
          <div class="m-code">${v.code ? `<span>ROOM CODE</span><b>${esc(v.code)}</b>${v.role === 'host' ? '<button data-a="copy">Copy</button>' : ''}` : '<span>Opening a room…</span>'}</div>
          <div class="m-players">${v.players.map((pl) => `<div><i style="background:${pl.look.shirt}"></i>${esc(pl.name)}${pl.host ? ' <em>host</em>' : ''}${pl.route === 'relay' ? ' <small>via relay</small>' : pl.route === 'direct' ? ' <small>direct</small>' : ''}</div>`).join('')}</div>
          <div class="m-note">${n} / ${MAX_PLAYERS} players · no AI squad in co-op · zombies ×${Math.pow(f, 0.6).toFixed(2)}, health ×${Math.pow(f, 0.4).toFixed(2)} of solo</div>
          ${v.status ? `<div class="m-note">${esc(v.status)}</div>` : ''}
          <div class="m-buttons">
            ${v.role === 'host' ? `<button data-a="start-coop" class="primary" ${v.code ? '' : 'disabled'}>Start game</button>` : `<div class="m-note">${v.inGame ? 'Game in progress — joining…' : 'Waiting for the host to start…'}</div>`}
            <button data-a="leave-room">${v.role === 'host' ? 'Close room' : 'Leave'}</button>
          </div></div>`;
        break;
      }
      case 'controls':
        html = `<div class="m-panel m-center"><h2>Controls</h2><table class="m-controls">${CONTROLS.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table>
          <div class="m-buttons"><button data-a="back" class="primary">Back</button></div></div>`;
        break;
      case 'settings': {
        const q = (v: Quality) => `<option value="${v}" ${s.quality === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`;
        html = `<div class="m-panel m-center"><h2>Settings</h2><div class="m-form">
          <label>Graphics quality <select data-s="quality">${q('low')}${q('medium')}${q('high')}${q('ultra')}</select></label>
          <label>Mouse sensitivity <input type="range" min="0.2" max="3" step="0.05" data-s="sensitivity" value="${s.sensitivity}"><output>${s.sensitivity.toFixed(2)}</output></label>
          <label>Field of view <input type="range" min="50" max="85" step="1" data-s="fov" value="${s.fov}"><output>${s.fov}</output></label>
          <label>Invert Y <input type="checkbox" data-s="invertY" ${s.invertY ? 'checked' : ''}></label>
          <label>Master volume <input type="range" min="0" max="1" step="0.01" data-s="masterVolume" value="${s.masterVolume}"><output>${Math.round(s.masterVolume * 100)}</output></label>
          <label>Music volume <input type="range" min="0" max="1" step="0.01" data-s="musicVolume" value="${s.musicVolume}"><output>${Math.round(s.musicVolume * 100)}</output></label>
          <label>Effects volume <input type="range" min="0" max="1" step="0.01" data-s="sfxVolume" value="${s.sfxVolume}"><output>${Math.round(s.sfxVolume * 100)}</output></label>
          <label>Squad voice lines <input type="checkbox" data-s="npcVoices" ${s.npcVoices ? 'checked' : ''}></label>
          <label>Show FPS <input type="checkbox" data-s="showFps" ${s.showFps ? 'checked' : ''}></label>
          <div class="m-note">Quality changes to shadows/AO apply on next load.</div>
          </div><div class="m-buttons"><button data-a="back" class="primary">Back</button></div></div>`;
        break;
      }
    }
    this.root.innerHTML = html;
    this.root.style.display = this.screen === 'none' ? 'none' : '';
    this.root.classList.toggle('dim', !['main', 'loading', 'character', 'coop', 'lobby'].includes(this.screen));
  }

  private onClick(e: Event): void {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.sw) {
      (this.profile.look as unknown as Record<string, string>)[b.dataset.sw] = b.dataset.c!;
      this.cb.onProfile(this.profile);
      this.render();
      return;
    }
    if (b.dataset.body) {
      this.profile.look.body = b.dataset.body === 'female' ? 'female' : 'male';
      this.cb.onProfile(this.profile);
      this.render();
      return;
    }
    switch (b.dataset.a) {
      case 'play': this.cb.onPlay(); break;
      case 'character': this.show('character'); break;
      case 'coop': this.coopError = ''; this.show('coop'); break;
      case 'back-main': this.show('main'); break;
      case 'host': this.coopError = ''; this.lobby = null; this.show('lobby'); this.cb.onHost(); break;
      case 'join': {
        const code = this.joinCode.trim();
        if (code.length < 5) { this.coopError = 'Enter the 5-letter room code.'; this.render(); break; }
        this.coopError = ''; this.lobby = null; this.show('lobby'); this.cb.onJoin(code);
        break;
      }
      case 'start-coop': this.cb.onStartCoop(); break;
      case 'leave-room': this.cb.onLeaveRoom(); break;
      case 'copy': if (this.lobby?.code) navigator.clipboard?.writeText(this.lobby.code).catch(() => {}); b.textContent = 'Copied'; break;
      case 'resume': this.cb.onResume(); break;
      case 'settings': this.show('settings'); this.screen = 'settings'; break;
      case 'controls': this.show('controls'); break;
      case 'back': this.show(this.prev); break;
      case 'quit': this.cb.onQuitToMenu(); break;
      case 'restart': this.cb.onRestart(); break;
    }
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.dataset.p === 'name') {
      this.profile.name = t.value.replace(/[<>&"]/g, '').slice(0, 16);
      if (e.type === 'change') { this.profile.name = this.profile.name.trim() || 'Student'; t.value = this.profile.name; }
      this.cb.onProfile(this.profile);
      return;
    }
    if (t.dataset.p === 'code') {
      this.joinCode = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      t.value = this.joinCode;
      return;
    }
    const key = t.dataset.s as keyof Settings | undefined;
    if (!key) return;
    const s = this.settings as unknown as Record<string, unknown>;
    if (t instanceof HTMLInputElement && t.type === 'checkbox') s[key] = t.checked;
    else if (t instanceof HTMLInputElement && t.type === 'range') {
      s[key] = Number(t.value);
      const out = t.nextElementSibling as HTMLOutputElement | null;
      if (out) out.textContent = key.includes('Volume') ? String(Math.round(Number(t.value) * 100)) : key === 'fov' ? t.value : Number(t.value).toFixed(2);
    } else s[key] = t.value;
    this.cb.onSettings(this.settings);
  }
}
