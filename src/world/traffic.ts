import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { QualityProfile } from '../core/Settings';
import { ORR, orrPoint } from './layout';
import { terrainY } from './terrain';

type VehicleKind = 'car_hatchback' | 'car_sedan' | 'auto_rickshaw' | 'motorbike' | 'bmtc_bus';

interface Vehicle {
  object: THREE.Group;
  kind: VehicleKind;
  t: number;
  speed: number;
  lane: number;
  direction: 1 | -1;
  phase: number;
  stopT: number;
  hijackT: number;
  hijacked: boolean;
  manualSpeed: number;
}

export interface TrafficObstacle {
  id: number;
  x: number;
  z: number;
  y: number;
  radius: number;
  speed: number;
  moving: boolean;
  zombieStop: boolean;
  hijackReady: boolean;
  hijacked: boolean;
  driveable: boolean;
  requestStop: () => void;
  hijack: () => void;
}

const MODEL_DIR = `${import.meta.env.BASE_URL}models/props/`;
const MODEL_URL: Record<VehicleKind, string> = {
  car_hatchback: `${MODEL_DIR}car_hatchback.glb`,
  car_sedan: `${MODEL_DIR}car_sedan.glb`,
  auto_rickshaw: `${MODEL_DIR}auto_rickshaw.glb`,
  motorbike: `${MODEL_DIR}motorbike.glb`,
  bmtc_bus: `${MODEL_DIR}bmtc_bus.glb`,
};

/** Ambient Outer Ring Road traffic; gameplay collision is applied by the authoritative World. */
export class TrafficSystem {
  readonly group = new THREE.Group();
  private readonly vehicles: Vehicle[] = [];
  private driving: { vehicle: Vehicle; playerId: number } | null = null;
  private readonly drawDistance: number;

  private constructor(private readonly multiLevel: boolean, drawDistance: number) {
    this.drawDistance = Math.min(520, Math.max(300, drawDistance));
    this.group.name = 'ambient-traffic';
  }

  static async create(assets: Assets, quality: QualityProfile, multiLevel: boolean): Promise<TrafficSystem> {
    const traffic = new TrafficSystem(multiLevel, quality.viewDistance);
    // Bengaluru-style mix: many two-wheelers and autos, with occasional cars and buses.
    const count = quality.viewDistance < 350 ? 20 : quality.viewDistance < 500 ? 32 : 48;
    const kinds: VehicleKind[] = ['motorbike', 'motorbike', 'auto_rickshaw', 'car_hatchback', 'motorbike', 'car_sedan', 'auto_rickshaw', 'bmtc_bus'];
    const models = new Map<VehicleKind, THREE.Object3D>();

    for (const kind of new Set(kinds.slice(0, Math.min(kinds.length, count)))) {
      const gltf = await assets.gltf(MODEL_URL[kind]);
      if (gltf) models.set(kind, gltf.scene);
    }

    const lane = (side: 1 | -1, index: number) => {
      const halfMain = (ORR.width - ORR.median) / 2;
      return side * (ORR.median / 2 + (halfMain / 3) * (index + 0.5));
    };
    for (let i = 0; i < count; i++) {
      const kind = kinds[i % kinds.length];
      const source = models.get(kind);
      if (!source) continue;
      const direction: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const object = source.clone(true) as THREE.Group;
      object.name = `traffic:${kind}:${i}`;
      object.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = quality.shadowMapSize > 0;
        mesh.receiveShadow = true;
      });
      traffic.group.add(object);
      traffic.vehicles.push({
        object,
        kind,
        t: -410 + i * 41,
        speed: (kind === 'bmtc_bus' ? 8 : kind === 'motorbike' ? 15 : kind === 'auto_rickshaw' ? 10 : 12) * (0.88 + (i % 3) * 0.08),
        lane: lane(direction, Math.floor(i / 2) % 3),
        direction,
        phase: i * 1.7,
        stopT: 0,
        hijackT: 0,
        hijacked: false,
        manualSpeed: 0,
      });
    }
    traffic.update(0);
    return traffic;
  }

  update(dt: number, camera?: THREE.Camera): void {
    const t0 = -430;
    const t1 = 330;
    const cameraPos = camera?.getWorldPosition(_cameraPos);
    const cameraDir = camera?.getWorldDirection(_cameraDir);
    for (const vehicle of this.vehicles) {
      if (vehicle.stopT > 0 && vehicle.stopT !== Infinity) vehicle.stopT -= dt;
      if (vehicle.hijackT > 0 && vehicle.hijackT < 2.5) vehicle.hijackT += dt;
      if (vehicle.stopT <= 0 && !vehicle.hijacked && this.driving?.vehicle !== vehicle) vehicle.t += vehicle.direction * vehicle.speed * dt;
      if (this.driving?.vehicle === vehicle) vehicle.t += vehicle.direction * vehicle.manualSpeed * dt;
      if (vehicle.t > t1 + 35) vehicle.t = t0 - 35;
      if (vehicle.t < t0 - 35) vehicle.t = t1 + 35;
      this.placeVehicle(vehicle);
      if (cameraPos && cameraDir) {
        _toVehicle.subVectors(vehicle.object.position, cameraPos);
        const distance = _toVehicle.length();
        const facing = distance > 0.001 ? cameraDir.dot(_toVehicle) / distance : 1;
        // Keep the road population dense, but only submit the portion the player can plausibly see.
        vehicle.object.visible = distance <= this.drawDistance && facing > -0.12;
      } else vehicle.object.visible = true;
    }
  }

  get obstacles(): TrafficObstacle[] {
    return this.vehicles.map((vehicle, id) => ({
      id,
      x: vehicle.object.position.x,
      z: vehicle.object.position.z,
      y: vehicle.object.position.y,
      radius: vehicle.kind === 'bmtc_bus' ? 2.2 : vehicle.kind === 'motorbike' ? 0.75 : 1.35,
      speed: this.driving?.vehicle === vehicle ? Math.abs(vehicle.manualSpeed) : vehicle.speed,
      moving: vehicle.stopT <= 0 && !vehicle.hijacked && (this.driving?.vehicle !== vehicle || Math.abs(vehicle.manualSpeed) > 0.5),
      zombieStop: vehicle.hijackT > 0,
      hijackReady: vehicle.hijackT >= 2.5,
      hijacked: vehicle.hijacked,
      driveable: vehicle.hijacked,
      requestStop: () => {
        if (vehicle.hijacked) return;
        vehicle.stopT = Infinity;
        vehicle.hijackT = vehicle.hijackT || 0.001;
      },
      hijack: () => {
        if (vehicle.hijacked || vehicle.hijackT <= 0) return;
        vehicle.hijacked = true;
        vehicle.stopT = Infinity;
        if (this.driving?.vehicle === vehicle) this.driving = null;
      },
    }));
  }

  /** Survivor takeover: F near an abandoned vehicle, WASD to drive, F to exit. */
  drive(playerId: number, player: { pos: THREE.Vector3; yaw: number }, input: { moveX: number; moveZ: number; command: boolean }, dt: number): boolean {
    if (this.driving && this.driving.playerId !== playerId) return false;
    if (!this.driving) {
      if (!input.command) return false;
      let best: Vehicle | null = null, bestD = 4;
      for (const vehicle of this.vehicles) {
        if (!vehicle.hijacked || vehicle.hijackT < 2.5) continue;
        const d = Math.hypot(vehicle.object.position.x - player.pos.x, vehicle.object.position.z - player.pos.z);
        if (d < bestD) { best = vehicle; bestD = d; }
      }
      if (!best) return false;
      this.driving = { vehicle: best, playerId };
      best.hijacked = false;
      best.hijackT = 0;
      best.stopT = Infinity;
      best.manualSpeed = 0;
      return true;
    }
    const vehicle = this.driving.vehicle;
    if (input.command) {
      this.driving = null;
      vehicle.stopT = 0;
      vehicle.hijacked = false;
      vehicle.manualSpeed = 0;
      return true;
    }
    const maxSpeed = vehicle.kind === 'bmtc_bus' ? 11 : vehicle.kind === 'motorbike' ? 24 : 18;
    const targetSpeed = input.moveZ * maxSpeed;
    const accel = Math.abs(targetSpeed) > 0.01 ? 18 : 26;
    vehicle.manualSpeed += THREE.MathUtils.clamp(targetSpeed - vehicle.manualSpeed, -accel * dt, accel * dt);
    const minLane = ORR.median / 2 + 0.9;
    const maxLane = ORR.width / 2 - 1.2;
    const laneAbs = THREE.MathUtils.clamp(Math.abs(vehicle.lane) - input.moveX * 4 * dt, minLane, maxLane);
    vehicle.lane = vehicle.direction * Math.min(laneAbs, maxLane);
    this.placeVehicle(vehicle);
    player.pos.copy(vehicle.object.position);
    player.yaw = Math.atan2(ORR.dir[0] * vehicle.direction, ORR.dir[1] * vehicle.direction);
    return true;
  }

  private placeVehicle(vehicle: Vehicle): void {
    const [x, z] = orrPoint(vehicle.t, vehicle.lane);
    const y = this.multiLevel ? terrainY(x, z) : 0;
    vehicle.object.position.set(x, y + 0.065, z);
    vehicle.object.rotation.y = Math.atan2(ORR.dir[0] * vehicle.direction, ORR.dir[1] * vehicle.direction);
    vehicle.object.position.y += Math.sin(vehicle.phase + vehicle.t * 0.05) * 0.008;
  }
}

const _cameraPos = new THREE.Vector3();
const _cameraDir = new THREE.Vector3();
const _toVehicle = new THREE.Vector3();
