import * as THREE from 'three';
import { ORR, ORR_NORMAL } from './layout';
import { ROAD_LOOP_HALF, ROAD_LOOP_LENGTH } from './streaming';

/** A finite Ring Road loop built from repeatable road sections rather than world-grid chunks. */
export class WorldStream {
  readonly group = new THREE.Group();
  private readonly sections = new Map<number, THREE.Group>();
  private readonly sectionLength = 96;
  private readonly sectionCount = ROAD_LOOP_LENGTH / this.sectionLength;
  private lastSection = -1;
  private readonly horizon = new THREE.Group();

  constructor() {
    this.group.name = 'ring-road-loop';
    this.horizon.name = 'loop-horizon-backdrops';
    this.group.add(this.horizon);
    this.addHorizonBackdrop(-ROAD_LOOP_HALF - 18);
    this.addHorizonBackdrop(ROAD_LOOP_HALF + 18);
  }

  update(player: THREE.Vector3): void {
    const dx = player.x - ORR.origin[0], dz = player.z - ORR.origin[1];
    const t = dx * ORR.dir[0] + dz * ORR.dir[1];
    const current = this.sectionAt(t);
    if (current === this.lastSection) return;
    this.lastSection = current;
    const wanted = new Set<number>();
    for (let offset = -4; offset <= 4; offset++) {
      const index = this.wrapIndex(current + offset);
      wanted.add(index);
      this.ensureSection(index);
    }
    for (const [index, section] of this.sections) {
      if (wanted.has(index)) continue;
      this.dispose(section);
      section.removeFromParent();
      this.sections.delete(index);
    }
  }

  private sectionAt(t: number): number {
    const wrapped = ((t + ROAD_LOOP_HALF) % ROAD_LOOP_LENGTH + ROAD_LOOP_LENGTH) % ROAD_LOOP_LENGTH;
    return Math.floor(wrapped / this.sectionLength);
  }

  private wrapIndex(index: number): number { return ((index % this.sectionCount) + this.sectionCount) % this.sectionCount; }

  private ensureSection(index: number): void {
    if (this.sections.has(index)) return;
    const t = -ROAD_LOOP_HALF + (index + 0.5) * this.sectionLength;
    // The middle remains the detailed authored campus rather than being covered by generated scenery.
    if (t > -430 && t < 330) {
      const empty = new THREE.Group();
      this.group.add(empty);
      this.sections.set(index, empty);
      return;
    }
    const [x, z] = this.point(t);
    const yaw = Math.atan2(ORR.dir[1], ORR.dir[0]);
    const section = new THREE.Group();
    section.name = `ring-road-section:${index}`;

    // Horizontal road slabs avoid the plane-rotation failure that created vertical road walls.
    const ground = this.mesh(new THREE.BoxGeometry(this.sectionLength + 2, 0.05, 172), 0x5c5545, 1);
    ground.position.set(x, -0.08, z); ground.rotation.y = yaw; section.add(ground);
    const road = this.mesh(new THREE.BoxGeometry(this.sectionLength + 2, 0.06, ORR.width), 0x272a2c, 0.95);
    road.position.set(x, -0.045, z); road.rotation.y = yaw; section.add(road);
    for (const side of [-1, 1]) {
      const shoulder = this.mesh(new THREE.BoxGeometry(this.sectionLength + 2, 0.035, 1.25), 0x777369, 1);
      shoulder.position.set(x + ORR_NORMAL[0] * side * (ORR.width / 2 + 0.62), -0.008, z + ORR_NORMAL[1] * side * (ORR.width / 2 + 0.62));
      shoulder.rotation.y = yaw; section.add(shoulder);
      const edge = this.mesh(new THREE.BoxGeometry(this.sectionLength + 1, 0.018, 0.16), 0xd9cf9b, 0.7, 0, false);
      edge.position.set(x + ORR_NORMAL[0] * side * (ORR.width / 2 - 0.75), 0.008, z + ORR_NORMAL[1] * side * (ORR.width / 2 - 0.75));
      edge.rotation.y = yaw; section.add(edge);
      const divider = this.mesh(new THREE.BoxGeometry(this.sectionLength * 0.9, 0.018, 0.14), 0xf0e8bf, 0.65, 0, false);
      divider.position.set(x + ORR_NORMAL[0] * side * (ORR.median / 2 + 3.5), 0.01, z + ORR_NORMAL[1] * side * (ORR.median / 2 + 3.5));
      divider.rotation.y = yaw; section.add(divider);
    }
    const median = this.mesh(new THREE.BoxGeometry(this.sectionLength + 2, 0.2, ORR.median), 0x53574f, 1);
    median.position.set(x, 0.07, z); median.rotation.y = yaw; section.add(median);

    const seed = this.rand(index * 19 + 7);
    for (const side of [-1, 1]) {
      this.addStreetlights(section, t, side, seed);
      this.addRoadside(section, t, side, index, seed);
    }
    this.group.add(section);
    this.sections.set(index, section);
  }

  private addStreetlights(section: THREE.Group, t: number, side: number, seed: number): void {
    for (const offset of [-31, 13]) {
      const [x, z] = this.point(t + offset, side * 18.5);
      const pole = this.mesh(new THREE.CylinderGeometry(0.09, 0.13, 8, 6), 0x30363b, 0.7, 0.1);
      pole.position.set(x, 4, z); section.add(pole);
      const lamp = this.mesh(new THREE.BoxGeometry(0.35, 0.16, 1.3), seed > 0.55 ? 0xd4b86c : 0xa7c8d6, 0.45, 0.15, false);
      lamp.position.set(x + ORR.dir[0] * 0.45, 7.85, z + ORR.dir[1] * 0.45);
      lamp.rotation.y = Math.atan2(ORR.dir[1], ORR.dir[0]); section.add(lamp);
    }
  }

  private addRoadside(section: THREE.Group, t: number, side: number, index: number, seed: number): void {
    const buildingCount = seed > 0.57 ? 2 : 1;
    for (let i = 0; i < buildingCount; i++) {
      const local = -20 + i * 38 + this.rand(index * 37 + i) * 8;
      const setback = 38 + this.rand(index * 41 + i) * 25;
      const [x, z] = this.point(t + local, side * setback);
      const width = 15 + this.rand(index * 43 + i) * 11;
      const depth = 13 + this.rand(index * 47 + i) * 9;
      const h = (2 + Math.floor(this.rand(index * 53 + i) * 4)) * 3.2;
      const facade = this.mesh(new THREE.BoxGeometry(width, h, depth), new THREE.Color().setHSL(0.065 + this.rand(index * 59 + i) * 0.055, 0.16, 0.37), 0.82);
      facade.position.set(x, h / 2, z);
      facade.rotation.y = Math.atan2(ORR.dir[1], ORR.dir[0]) + (side < 0 ? 0.12 : -0.12);
      section.add(facade);
      const glass = this.mesh(new THREE.BoxGeometry(width * 0.78, 0.72, 0.06), 0x55727d, 0.3, 0.05, false);
      glass.position.copy(facade.position).add(new THREE.Vector3(0, h * 0.12, 0));
      glass.rotation.copy(facade.rotation); section.add(glass);
    }
    for (let i = 0; i < 3; i++) {
      const [x, z] = this.point(t - 28 + i * 28 + this.rand(index * 71 + i) * 6, side * (27 + this.rand(index * 73 + i) * 9));
      section.add(this.tree(x, z, 0.8 + this.rand(index * 79 + i) * 0.5));
    }
  }

  private tree(x: number, z: number, scale: number): THREE.Group {
    const g = new THREE.Group();
    const trunk = this.mesh(new THREE.CylinderGeometry(0.2 * scale, 0.28 * scale, 3.2 * scale, 6), 0x4b3828, 1);
    trunk.position.y = 1.6 * scale;
    const crown = this.mesh(new THREE.IcosahedronGeometry(2.1 * scale, 1), 0x3f6b43, 1, 0, true);
    crown.position.y = 4.3 * scale;
    g.add(trunk, crown); g.position.set(x, 0, z);
    return g;
  }

  /** Painted, alpha-faded city horizon hides the loop hand-off without a hard wall or image asset dependency. */
  private addHorizonBackdrop(t: number): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, 'rgba(178,208,226,0)'); sky.addColorStop(0.56, 'rgba(185,191,183,0.08)'); sky.addColorStop(1, 'rgba(76,75,70,0.92)');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, canvas.width, canvas.height);
    let x = -20;
    for (let i = 0; i < 26; i++) {
      const w = 28 + ((i * 31) % 72), h = 65 + ((i * 47) % 230);
      ctx.fillStyle = i % 3 === 0 ? '#5c6060' : i % 3 === 1 ? '#73736c' : '#4e5354';
      ctx.fillRect(x, canvas.height - h, w, h);
      ctx.fillStyle = 'rgba(233,211,148,0.18)';
      for (let row = canvas.height - h + 14; row < canvas.height - 8; row += 18) ctx.fillRect(x + 8, row, Math.max(3, w - 16), 3);
      x += w + 9;
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(150, 75), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const [x0, z0] = this.point(t);
    plane.position.set(x0, 28, z0); plane.rotation.y = Math.atan2(ORR.dir[0], ORR.dir[1]);
    this.horizon.add(plane);
  }

  private point(t: number, offset = 0): [number, number] {
    return [ORR.origin[0] + ORR.dir[0] * t + ORR_NORMAL[0] * offset, ORR.origin[1] + ORR.dir[1] * t + ORR_NORMAL[1] * offset];
  }

  private rand(n: number): number { return Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1; }

  private mesh(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, roughness: number, emissive = 0, shadows = true): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.03, emissive, emissiveIntensity: emissive ? 0.3 : 0 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = shadows; mesh.receiveShadow = true;
    return mesh;
  }

  private dispose(group: THREE.Object3D): void {
    group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => material.dispose());
    });
  }
}
