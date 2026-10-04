import * as THREE from 'three';
import type { GameEvents } from '../core/Events';
import type { Survivor } from '../sim/actors';
import { SPREAD_MAX, type World } from '../sim/World';
import { GRENADE, WEAPONS } from '../sim/weapons';
import { BUILDINGS, GATES, ROADS, STATIONS, WALLS, WORLD_BOUNDS, type V2 } from '../world/layout';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const _plate = new THREE.Vector3();
/** Frag grenade silhouette for the HUD count (body, fuse head, lever, pull ring). */
const NADE_SVG = '<svg viewBox="0 0 12 17" aria-hidden="true"><ellipse cx="6" cy="11" rx="4.3" ry="5.2" fill="currentColor"/>'
  + '<rect x="4.3" y="3.2" width="3.4" height="2.8" rx="0.6" fill="currentColor"/><path d="M7.6 3.6 L10.4 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
  + '<circle cx="3.1" cy="3" r="1.7" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>';

export class Hud {
  root = el('div', 'hud');
  private waveEl = el('div', 'hud-wave');
  private waveSub = el('div', 'hud-wave-sub');
  private banner = el('div', 'hud-banner');
  private msgs = el('div', 'hud-msgs');
  private cross = el('div', 'hud-cross');
  private hitmark = el('div', 'hud-hitmark');
  private prompt = el('div', 'hud-prompt');
  private promptBar = el('div', 'hud-prompt-bar');
  private weaponName = el('div', 'hud-weapon-name');
  private ammo = el('div', 'hud-ammo');
  private nades = el('div', 'hud-nades');
  private points = el('div', 'hud-points');
  private popups = el('div', 'hud-popups');
  private health = el('div', 'hud-health');
  private healthFill = el('div', 'hud-health-fill');
  private healthTxt = el('div', 'hud-health-txt');
  private squad = el('div', 'hud-squad');
  private board = el('div', 'hud-board');
  private nameEl = el('div', 'hud-name');
  private plates = el('div', 'hud-plates');
  private plateEls = new Map<number, HTMLElement>();
  private lastBoard = '';
  /** co-op: set by Game (null in solo); ping in ms per survivor id when known */
  coop: { rtt: (id: number) => number | undefined } | null = null;
  private damageLayer = el('div', 'hud-damage');
  private vignette = el('div', 'hud-vignette');
  private gateBar = el('div', 'hud-gate');
  private down = el('div', 'hud-down');
  private reload = el('div', 'hud-reload');
  private fps = el('div', 'hud-fps');
  private minimap = el('canvas', 'hud-minimap') as HTMLCanvasElement;
  private mapBase: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private squadCards = new Map<number, HTMLElement>();
  private hitT = 0;
  private hitHead = false;
  private lastPoints = -1;
  private lastAmmo = '';
  private lastNades = -1;
  private fpsAcc = 0;
  private fpsN = 0;
  showFps = false;
  private offs: (() => void)[] = [];

  constructor(parent: HTMLElement) {
    this.root.append(
      this.vignette, this.damageLayer, this.waveEl, this.waveSub, this.banner, this.msgs, this.cross, this.hitmark, this.reload,
      this.prompt, this.gateBar, this.down, this.popups, this.squad, this.fps, this.plates, this.nameEl,
    );
    this.squad.append(this.board);
    this.prompt.append(el('span'), this.promptBar);
    const wbox = el('div', 'hud-weapon');
    const ammoRow = el('div', 'hud-ammo-row');
    ammoRow.append(this.nades, this.ammo);
    wbox.append(this.weaponName, ammoRow, this.points);
    this.root.append(wbox);
    this.health.append(this.healthFill, this.healthTxt);
    this.root.append(this.health);
    this.cross.innerHTML = '<i></i><i></i><i></i><i></i><b></b>';
    this.minimap.width = this.minimap.height = 220;
    this.root.append(this.minimap);
    this.mctx = this.minimap.getContext('2d')!;
    this.mapBase = this.buildMapBase();
    parent.append(this.root);
    this.root.style.display = 'none';
  }

  show(v: boolean): void { this.root.style.display = v ? '' : 'none'; }

  attach(world: World): void {
    this.offs.forEach((o) => o());
    this.offs = [];
    const ev = world.events;
    const on = <K extends keyof GameEvents>(k: K, fn: (e: GameEvents[K]) => void) => this.offs.push(ev.on(k, fn));
    on('message', (e) => { if (!e.to || e.to === world.localPlayerId) this.message(e.text, e.kind); });
    on('hit', (e) => { if (e.attackerId === world.localPlayerId) { this.hitT = 0.18; this.hitHead = e.headshot; } });
    on('death', (e) => { if (e.kind === 'zombie' && e.killerId === world.localPlayerId) { this.hitT = 0.3; this.hitmark.classList.add('kill'); setTimeout(() => this.hitmark.classList.remove('kill'), 300); } });
    on('points', (e) => { if (e.playerId === world.localPlayerId && e.reason) this.popup(`${e.amount > 0 ? '+' : ''}${e.amount} ${e.reason}`, e.amount > 0); });
    on('playerDamaged', (e) => { if (e.playerId === world.localPlayerId) this.damageFrom(e.fromDir); });
    on('waveStart', (e) => this.bannerShow(`WAVE ${e.wave}`, e.wave === 1 ? 'They broke through the Ring Road. Hold the main gate!' : `${e.count} of them. Stay together.`));
    on('waveEnd', (e) => this.bannerShow(`WAVE ${e.wave} SURVIVED`, 'Restock at the ammo crates. Repair the gate (hold E).', 'good'));
    on('gateBroken', () => this.bannerShow('GATE BREACHED', 'Fall back and regroup!', 'bad'));
    on('grenadeExplode', (e) => { if (e.ownerId === world.localPlayerId && e.kills >= 2) this.popup(`${e.kills}× grenade multi-kill`, true); });
    on('pickup', (e) => { if (e.kind === 'weapon' && e.playerId === world.localPlayerId) this.message(`Picked up ${WEAPONS[e.item as keyof typeof WEAPONS]?.name ?? e.item}`, 'good'); });
    on('downed', (e) => { const s = world.survivors.find((x) => x.id === e.id); if (s && s.id !== world.localPlayerId) this.message(`${s.name} is down! Hold E near them to revive.`, 'warn'); });
    this.lastBoard = '';
    for (const [, pe] of this.plateEls) pe.remove();
    this.plateEls.clear();
    for (const [, c] of this.squadCards) c.remove();
    this.squadCards.clear();
  }

  message(text: string, kind: 'info' | 'warn' | 'good'): void {
    const m = el('div', `hud-msg ${kind}`, text);
    this.msgs.prepend(m);
    while (this.msgs.children.length > 5) this.msgs.lastChild?.remove();
    setTimeout(() => m.classList.add('fade'), 5000);
    setTimeout(() => m.remove(), 6000);
  }

  private popup(text: string, good: boolean): void {
    const p = el('div', `hud-popup ${good ? 'good' : 'bad'}`, text);
    this.popups.prepend(p);
    while (this.popups.children.length > 6) this.popups.lastChild?.remove();
    setTimeout(() => p.remove(), 1600);
  }

  private bannerShow(title: string, sub: string, kind: 'normal' | 'good' | 'bad' = 'normal'): void {
    this.banner.className = `hud-banner show ${kind}`;
    this.banner.innerHTML = `<div class="t">${title}</div><div class="s">${sub}</div>`;
    clearTimeout((this.banner as any)._t);
    (this.banner as any)._t = setTimeout(() => this.banner.classList.remove('show'), 3800);
  }

  private camYaw = 0;
  private damageFrom(dir: THREE.Vector3 | null): void {
    const d = el('div', 'hud-dmg-arc');
    if (dir) {
      // angle relative to camera: 0 = in front
      const a = Math.atan2(-dir.x, -dir.z) - this.camYaw;
      d.style.transform = `translate(-50%, -50%) rotate(${-a}rad)`;
    } else d.classList.add('all');
    this.damageLayer.append(d);
    setTimeout(() => d.remove(), 900);
  }

  update(dt: number, world: World, cam: THREE.PerspectiveCamera, camYaw: number): void {
    this.camYaw = camYaw;
    const p = world.player;
    if (!p) return;
    // wave / prep
    if (world.state === 'prep') {
      this.waveEl.textContent = world.wave === 0 ? 'GET READY' : `WAVE ${world.wave + 1} INCOMING`;
      this.waveSub.innerHTML = `Next wave in <b>${Math.max(0, Math.ceil(world.stateT))}s</b>${world.role === 'client' ? '' : ' · press <kbd>N</kbd> to start now'}`;
    } else if (world.state === 'active') {
      const alive = world.zombies.reduce((n, z) => n + (z.alive ? 1 : 0), 0);
      this.waveEl.textContent = `WAVE ${world.wave}`;
      const crisis = world.crisis === 'traffic_surge' ? 'TRAFFIC SURGE — keep the road clear'
        : world.crisis === 'gate_breach' ? 'GATE EMERGENCY — repair and defend'
          : world.crisis === 'emergency_resupply' ? 'SUPPLY DROP — collect nearby supplies' : '';
      this.waveSub.innerHTML = `<b>${alive + world.toSpawn}</b> zombies left${crisis ? `<br><em>${crisis} · ${Math.ceil(world.crisisT)}s</em>` : ''}`;
    } else if (world.state === 'gameover') {
      this.waveEl.textContent = '';
      this.waveSub.textContent = '';
    }
    // weapon / ammo / points
    const slot = p.slot;
    const def = WEAPONS[slot.id];
    const ammoTxt = def.kind === 'gun' ? `<b>${slot.mag}</b><span>/ ${slot.reserve}</span>` : '<b>∞</b>';
    if (ammoTxt !== this.lastAmmo) {
      this.ammo.innerHTML = ammoTxt;
      this.ammo.classList.toggle('low', def.kind === 'gun' && slot.mag <= Math.ceil(def.mag * 0.25));
      this.lastAmmo = ammoTxt;
    }
    if (p.grenades !== this.lastNades) {
      this.lastNades = p.grenades;
      let icons = '<kbd>G</kbd>';
      for (let i = 0; i < GRENADE.max; i++) icons += `<i class="${i < p.grenades ? 'on' : ''}">${NADE_SVG}</i>`;
      this.nades.innerHTML = icons;
      this.nades.title = `${p.grenades} grenade${p.grenades === 1 ? '' : 's'}`;
    }
    this.weaponName.innerHTML = p.weapons.map((w, i) => `<span class="${i === p.current ? 'on' : ''}">${i + 1} ${WEAPONS[w.id].name}</span>`).join('');
    const pts = world.points.get(p.id) ?? 0;
    if (pts !== this.lastPoints) { this.points.innerHTML = `<span>POINTS</span> ${pts.toLocaleString('en-IN')}`; this.lastPoints = pts; }
    // health
    const hp = Math.max(0, p.health / p.maxHealth);
    this.healthFill.style.width = `${hp * 100}%`;
    this.healthFill.classList.toggle('low', hp < 0.35);
    this.healthTxt.textContent = `${Math.ceil(p.health)}`;
    this.vignette.style.opacity = `${Math.max(0, (0.5 - hp) * 1.6) + (p.downed ? 0.6 : 0)}`;
    // crosshair & hitmarker: the gap blooms with the sim's next-shot spread (world.playerSpread()), but it is an
    // indicator, not the cone: SPREAD_MAX is divided back out and the old 420 px/rad scale kept, since the
    // worst-case bound drew the ring about 2.6x wider than where shots cluster
    const px = Math.round(6 + (world.playerSpread() / SPREAD_MAX) * 420);
    this.cross.style.setProperty('--gap', `${px}px`);
    this.cross.style.opacity = p.downed || def.kind !== 'gun' ? '0.25' : '1';
    this.hitT = Math.max(0, this.hitT - dt);
    this.hitmark.style.opacity = `${Math.min(1, this.hitT * 8)}`;
    this.hitmark.classList.toggle('head', this.hitHead);
    // reload ring
    if (p.reloadT >= 0 && p.reloadDur > 0) {
      this.reload.style.display = 'block';
      this.reload.style.setProperty('--p', `${Math.min(1, p.reloadT / p.reloadDur) * 360}deg`);
    } else this.reload.style.display = 'none';
    // interaction prompt
    const it = world.getInteract(p);
    if (it.prompt) {
      this.prompt.style.display = 'block';
      (this.prompt.firstChild as HTMLElement).textContent = it.prompt.text;
      this.prompt.classList.toggle('cant', !it.prompt.canAfford);
      this.promptBar.style.width = it.kind === 'revive' || it.kind === 'repair' ? `${it.prompt.progress * 100}%` : '0';
    } else this.prompt.style.display = 'none';
    // gate status
    const g = world.gates.find((gg) => gg.id === 'main');
    const nearGate = g && (world.time - g.lastHitT < 4 || Math.hypot(p.pos.x - (g.a[0] + g.b[0]) / 2, p.pos.z - (g.a[1] + g.b[1]) / 2) < 25);
    if (g && nearGate) {
      this.gateBar.style.display = 'block';
      this.gateBar.innerHTML = `<span>MAIN GATE</span><div class="bar"><div style="width:${(g.hp / g.maxHp) * 100}%"></div></div>${g.broken ? '<em>BREACHED</em>' : ''}`;
    } else this.gateBar.style.display = 'none';
    // downed overlay
    if (p.downed) {
      this.down.style.display = 'block';
      const reviving = p.reviveProgress > 0.01;
      this.down.innerHTML = `<div class="t">YOU'RE DOWN</div><div class="s">${reviving ? `Being revived… ${Math.round(p.reviveProgress * 100)}%` : `Bleeding out in ${Math.ceil(p.bleedout)}s — your squad is coming`}</div>`;
    } else this.down.style.display = 'none';
    this.updateSquad(world);
    this.updateBoard(world, p);
    this.updatePlates(world, cam);
    this.drawMinimap(world, p, camYaw);
    // fps
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps.style.display = this.showFps ? 'block' : 'none';
      this.fps.textContent = `${Math.round(this.fpsN / this.fpsAcc)} fps`;
      this.fpsAcc = 0; this.fpsN = 0;
    }
    void cam;
  }

  /** Your name over the health bar; in co-op, the players ranked by score (points earned, spending doesn't count). */
  private updateBoard(world: World, me: Survivor): void {
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const nm = esc(me.name);
    if (this.nameEl.dataset.n !== nm) { this.nameEl.dataset.n = nm; this.nameEl.innerHTML = `<i style="background:${me.look.shirt}"></i>${nm}`; }
    if (!this.coop) { if (this.lastBoard) { this.board.innerHTML = ''; this.lastBoard = ''; } return; }
    const rows = world.survivors.filter((s) => s.kind === 'player')
      .map((s) => ({ s, score: world.score.get(s.id) ?? 0 }))
      .sort((a, b) => b.score - a.score || b.s.kills - a.s.kills);
    const html = `<div class="hdr"><span>#</span><span>PLAYER</span><span>SCORE</span><span>KILLS</span></div>` + rows.map(({ s, score }, i) => {
      const st = !s.alive ? '<em class="dead">DEAD</em>' : s.downed ? '<em class="down">DOWN</em>' : '';
      const ping = s.id === me.id ? undefined : this.coop!.rtt(s.id);
      return `<div class="row${s.id === me.id ? ' you' : ''}"><span>${i + 1}</span><span><i style="background:${s.look.shirt}"></i>${esc(s.name)}${st}${ping !== undefined ? `<small>${ping}ms</small>` : ''}</span><span>${score.toLocaleString('en-IN')}</span><span>${s.kills}</span></div>`;
    }).join('');
    if (html !== this.lastBoard) { this.board.innerHTML = html; this.lastBoard = html; }
  }

  /** Name + health over other players' heads (co-op). */
  private updatePlates(world: World, cam: THREE.PerspectiveCamera): void {
    const seen = new Set<number>();
    if (this.coop) {
      const w = this.root.clientWidth || innerWidth, h = this.root.clientHeight || innerHeight;
      for (const s of world.survivors) {
        if (s.kind !== 'player' || s.id === world.localPlayerId || !s.alive) continue;
        _plate.set(s.pos.x, s.pos.y + (s.downed ? 0.8 : 1.92), s.pos.z);
        const dist = _plate.distanceTo(cam.position);
        _plate.project(cam);
        if (_plate.z > 1 || dist > 90 || Math.abs(_plate.x) > 1.1 || Math.abs(_plate.y) > 1.1) continue;
        seen.add(s.id);
        let pe = this.plateEls.get(s.id);
        if (!pe) {
          pe = el('div', 'hud-plate', `<span></span><div><div></div></div>`);
          this.plates.append(pe);
          this.plateEls.set(s.id, pe);
        }
        (pe.firstChild as HTMLElement).textContent = s.downed ? `${s.name} — DOWN` : s.name;
        ((pe.lastChild as HTMLElement).firstChild as HTMLElement).style.width = `${Math.max(0, s.health / s.maxHealth) * 100}%`;
        pe.classList.toggle('down', s.downed);
        pe.style.transform = `translate(${((_plate.x + 1) / 2) * w}px, ${((1 - _plate.y) / 2) * h}px) translate(-50%, -100%) scale(${THREE.MathUtils.clamp(14 / Math.max(1, dist), 0.6, 1)})`;
      }
    }
    for (const [id, pe] of this.plateEls) if (!seen.has(id)) { pe.remove(); this.plateEls.delete(id); }
  }

  private updateSquad(world: World): void {
    for (const s of world.survivors) {
      if (s.kind !== 'npc') continue;
      let card = this.squadCards.get(s.id);
      if (!card) {
        card = el('div', 'hud-card', `<div class="n">${s.name}</div><div class="b"><div></div></div><div class="st"></div>`);
        this.squad.append(card);
        this.squadCards.set(s.id, card);
      }
      const bar = card.querySelector('.b > div') as HTMLElement;
      bar.style.width = `${Math.max(0, s.health / s.maxHealth) * 100}%`;
      const st = card.querySelector('.st') as HTMLElement;
      const brain = world.brains.get(s.id);
      const status = !s.alive ? 'KIA' : s.downed ? `DOWN ${Math.ceil(s.bleedout)}s` : s.anim.reviving ? 'REVIVING' : brain?.mode === 'hold' ? 'HOLDING' : 'FOLLOWING';
      st.textContent = `${WEAPONS[s.slot.id].name.split(' ').pop()} · ${status}`;
      card.classList.toggle('down', s.downed);
      card.classList.toggle('dead', !s.alive);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------------------------
  private buildMapBase(): HTMLCanvasElement {
    const b = WORLD_BOUNDS;
    const S = 2; // px per metre
    const c = document.createElement('canvas');
    c.width = (b.maxX - b.minX) * S;
    c.height = (b.maxZ - b.minZ) * S;
    const g = c.getContext('2d')!;
    const tx = (x: number) => (x - b.minX) * S, tz = (z: number) => (z - b.minZ) * S;
    g.fillStyle = 'rgba(20,24,28,0.9)';
    g.fillRect(0, 0, c.width, c.height);
    const poly = (pts: V2[], fill: string, stroke?: string) => {
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(tx(x), tz(z)) : g.moveTo(tx(x), tz(z))));
      g.closePath();
      g.fillStyle = fill; g.fill();
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
    };
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const r of ROADS) {
      g.strokeStyle = 'rgba(90,96,104,0.9)';
      g.lineWidth = r.width * S;
      g.beginPath();
      r.pts.forEach(([x, z], i) => (i ? g.lineTo(tx(x), tz(z)) : g.moveTo(tx(x), tz(z))));
      g.stroke();
    }
    for (const bd of BUILDINGS) poly(bd.poly, bd.base ? 'rgba(120,130,140,0.35)' : 'rgba(170,176,184,0.95)', 'rgba(40,40,40,0.8)');
    g.strokeStyle = 'rgba(210,190,150,0.9)';
    g.lineWidth = 2;
    for (const w of WALLS) { g.beginPath(); w.pts.forEach(([x, z], i) => (i ? g.lineTo(tx(x), tz(z)) : g.moveTo(tx(x), tz(z)))); g.stroke(); }
    for (const gt of GATES) { g.strokeStyle = '#ffb020'; g.lineWidth = 4; g.beginPath(); g.moveTo(tx(gt.a[0]), tz(gt.a[1])); g.lineTo(tx(gt.b[0]), tz(gt.b[1])); g.stroke(); }
    for (const st of STATIONS) {
      g.fillStyle = st.kind === 'ammo' ? '#f2b233' : st.kind === 'health' ? '#e5484d' : st.kind === 'grenade' ? '#b8c46a' : '#46c46e';
      g.beginPath(); g.arc(tx(st.pos[0]), tz(st.pos[1]), 4, 0, Math.PI * 2); g.fill();
    }
    return c;
  }

  private drawMinimap(world: World, p: Survivor, camYaw: number): void {
    const g = this.mctx;
    const W = this.minimap.width, H = this.minimap.height;
    const b = WORLD_BOUNDS;
    const S = 2, zoom = 0.8; // canvas px per metre on screen = S*zoom
    g.clearRect(0, 0, W, H);
    g.save();
    g.beginPath(); g.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); g.clip();
    g.translate(W / 2, H / 2);
    g.rotate(camYaw);
    g.scale(zoom, zoom);
    g.translate(-(p.pos.x - b.minX) * S, -(p.pos.z - b.minZ) * S);
    g.drawImage(this.mapBase, 0, 0);
    const tx = (x: number) => (x - b.minX) * S, tz = (z: number) => (z - b.minZ) * S;
    for (const z of world.zombies) {
      if (!z.alive) continue;
      if (Math.abs(z.pos.x - p.pos.x) > 90 || Math.abs(z.pos.z - p.pos.z) > 90) continue;
      g.fillStyle = z.type === 'brute' ? '#ff3b3b' : '#e0443f';
      g.beginPath(); g.arc(tx(z.pos.x), tz(z.pos.z), z.type === 'brute' ? 5 : 3, 0, Math.PI * 2); g.fill();
    }
    for (const s of world.survivors) {
      if (!s.alive || s === p) continue;
      g.fillStyle = s.downed ? '#ffb020' : '#4fa3ff';
      g.beginPath(); g.arc(tx(s.pos.x), tz(s.pos.z), 4, 0, Math.PI * 2); g.fill();
    }
    for (const pk of world.pickups) {
      g.fillStyle = pk.kind === 'ammo' ? '#f2b233' : '#ff6b6b';
      g.fillRect(tx(pk.pos.x) - 2, tz(pk.pos.z) - 2, 4, 4);
    }
    g.restore();
    // player arrow (always up)
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(W / 2, H / 2 - 8); g.lineTo(W / 2 + 6, H / 2 + 6); g.lineTo(W / 2, H / 2 + 2); g.lineTo(W / 2 - 6, H / 2 + 6); g.closePath(); g.fill();
    // north marker
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(camYaw);
    g.fillStyle = '#f2b233';
    g.font = '700 13px Inter, sans-serif';
    g.textAlign = 'center';
    g.fillText('N', 0, -H / 2 + 16);
    g.restore();
  }
}
