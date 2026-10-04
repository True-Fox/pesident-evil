import * as THREE from 'three';
import type { Assets } from '../core/Assets';
import type { SurfaceKind } from '../core/Events';
import type { QualityProfile } from '../core/Settings';
import { StaticCollision } from '../sim/Collision';
import { distToSegment, pointInPoly, polylineToStrip, rng, samplePolyline } from './geom';
import { AREAS, BUILDINGS, GATES, GLOBE_POS, GLOBE_Y, ORR, orrPoint, PLAYER_SPAWN, QUAD, ROADS, SPAWN_ZONES, STATIONS, STEP_STACKS, type GateDef, type StationDef, type V2 } from './layout';
import { parkingSlots } from './gjb/parking';
import { injectWorldLighting } from './materials';
import { liftY } from './terrain';
import { grenadeAssets } from '../render/Grenades';

/**
 * Prop dressing for the campus and the Outer Ring Road.
 *
 * Rendering: every prop GLB is flattened at load time into ONE vertex-coloured geometry (node transforms baked in).
 * Per-vertex roughness / metalness / emission / tint-mask live in a `pbr` vec4 attribute read by a single shared
 * MeshStandardMaterial, and recolourable `body` materials (car, scooter) take their paint from instance colours
 * (masked so tyres/glass stay put). So each prop type costs one InstancedMesh per region chunk (+1 for the metro
 * barrier's textured net), instead of one per glTF primitive (the GLBs have 3–13 primitives each).
 * Station furniture, displayed weapons and the construction pit are merged into one static mesh.
 *
 * Collision is deterministic (seeded, independent of quality) so a future co-op host/client agree on it.
 */
export interface PropsBuild {
  group: THREE.Group;
  stationAnchors: Map<string, THREE.Object3D>;
}

const MODEL_DIR = `${import.meta.env.BASE_URL}models/`;
/**
 * Per prop type: [unused (old chunk size), shadow-casting distance m, draw distance m]. Every prop type is one
 * InstancedProp with per-instance distance bands (see lodLevels): full model with shadows up to the shadow distance,
 * without shadows up to LOD_DIST, then the `_lod` model, nothing past the draw distance. The low evening sun
 * stretches the shadow frustum ~400 m, so this keeps the shadow pass to props near the camera.
 */
/** distance (m, camera to instance) at which protos with a low-poly `_lod` model switch to it */
const LOD_DIST: Record<string, number> = { car: 38, car_sedan: 38, auto: 32, bike: 13, motorbike: 13, college_bus: 60, bus: 60, barricade: 30 };
const CHUNK: Record<string, [number, number, number]> = {
  // [cell m (unused), shadow-casting distance m, draw distance m]; LOD'd types cast shadows only from the full model
  // (shadow distance = LOD distance), so each costs two bands (≤ 2 draw calls + 1 shadow draw) when in view
  bike: [32, 13, 120], motorbike: [32, 13, 120], bench: [48, 35, 120], bin: [40, 25, 95], chair: [40, 0, 80], cooler: [40, 25, 95], ammo: [40, 25, 110],
  medkit: [40, 0, 80], table: [48, 35, 120], sandbags: [48, 50, 170], stackbags: [48, 30, 60], barricade: [48, 30, 170], metro: [64, 55, 240],
  car: [64, 38, 280], car_sedan: [64, 38, 280], auto: [64, 32, 240], bus: [96, 60, 420], college_bus: [96, 60, 380], globe: [128, 120, 420],
};
const CHUNK_DEFAULT: [number, number, number] = [96, 70, 250];
const HALF_PI = Math.PI / 2;
const DEG = Math.PI / 180;

/**
 * Keep every channel ≥ 28 % of the colour's mean. postprocessing's HueSaturationEffect (saturation > 0, as used in
 * Post.ts) only clamps the top, so strongly saturated colours (red chairs, blue bins, red paint) end up with negative
 * channels that turn into NaN/black at output. This floor is visually negligible and keeps props safe either way.
 */
function safeColor(c: THREE.Color): THREE.Color {
  const f = ((c.r + c.g + c.b) / 3) * 0.28;
  return c.setRGB(Math.max(c.r, f), Math.max(c.g, f), Math.max(c.b, f));
}

// ---------------------------------------------------------------------------------------------
// Shared "flat PBR" material: base colour from vertex colours, roughness/metalness/emission/tint-mask per vertex.
// ---------------------------------------------------------------------------------------------
function makeFlatMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.name = 'prop_flat';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 pbr;\nvarying vec3 vPbr;')
      .replace('vColor.rgb *= instanceColor.rgb;', 'vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, pbr.w );')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr.xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPbr;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vPbr.z;');
    injectWorldLighting(sh); // street-lamp light map at night (materials.ts)
  };
  m.customProgramCacheKey = () => 'prop_flat_pbr_v2';
  return m;
}

type PBR4 = [number, number, number, number];
interface FlatSrc { geo: THREE.BufferGeometry; color?: THREE.Color; pbr?: PBR4; mat?: string }

/** Merge geometries into one indexed geometry with position/normal/color/pbr (constants fill missing attributes). */
function mergeFlat(src: FlatSrc[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const s of src) {
    const c = s.geo.attributes.position.count;
    nv += c;
    ni += s.geo.index ? s.geo.index.count : c;
  }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), pbr = new Float32Array(nv * 4);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const s of src) {
    const P = s.geo.attributes.position as THREE.BufferAttribute;
    const N = s.geo.attributes.normal as THREE.BufferAttribute | undefined;
    const C = s.geo.attributes.color as THREE.BufferAttribute | undefined;
    const R = s.geo.attributes.pbr as THREE.BufferAttribute | undefined;
    const cc = s.color ?? new THREE.Color(1, 1, 1);
    const pp = s.pbr ?? [0.8, 0, 0, 0];
    for (let i = 0; i < P.count; i++) {
      const o = (vo + i) * 3;
      pos[o] = P.getX(i); pos[o + 1] = P.getY(i); pos[o + 2] = P.getZ(i);
      if (N) { nrm[o] = N.getX(i); nrm[o + 1] = N.getY(i); nrm[o + 2] = N.getZ(i); } else nrm[o + 1] = 1;
      if (C) { col[o] = C.getX(i); col[o + 1] = C.getY(i); col[o + 2] = C.getZ(i); } else { col[o] = cc.r; col[o + 1] = cc.g; col[o + 2] = cc.b; }
      const q = (vo + i) * 4;
      if (R) { pbr[q] = R.getX(i); pbr[q + 1] = R.getY(i); pbr[q + 2] = R.getZ(i); pbr[q + 3] = R.getW(i); } else { pbr[q] = pp[0]; pbr[q + 1] = pp[1]; pbr[q + 2] = pp[2]; pbr[q + 3] = pp[3]; }
    }
    const I = s.geo.index;
    if (I) for (let i = 0; i < I.count; i++) idx[io++] = I.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) idx[io++] = vo + i;
    vo += P.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('pbr', new THREE.BufferAttribute(pbr, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Keep only triangles whose centroid passes `keep`; vertices are compacted. */
function filterTris(geo: THREE.BufferGeometry, keep: (cx: number, cy: number, cz: number) => boolean): THREE.BufferGeometry | null {
  const P = geo.attributes.position as THREE.BufferAttribute;
  const N = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const U = geo.attributes.uv as THREE.BufferAttribute | undefined;
  const I = geo.index;
  const n = I ? I.count : P.count;
  const remap = new Int32Array(P.count).fill(-1);
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const v = [I ? I.getX(t) : t, I ? I.getX(t + 1) : t + 1, I ? I.getX(t + 2) : t + 2];
    const cx = (P.getX(v[0]) + P.getX(v[1]) + P.getX(v[2])) / 3;
    const cy = (P.getY(v[0]) + P.getY(v[1]) + P.getY(v[2])) / 3;
    const cz = (P.getZ(v[0]) + P.getZ(v[1]) + P.getZ(v[2])) / 3;
    if (!keep(cx, cy, cz)) continue;
    for (const k of v) {
      if (remap[k] < 0) {
        remap[k] = pos.length / 3;
        pos.push(P.getX(k), P.getY(k), P.getZ(k));
        if (N) nrm.push(N.getX(k), N.getY(k), N.getZ(k));
        if (U) uv.push(U.getX(k), U.getY(k));
      }
      idx.push(remap[k]);
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (N) g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  if (U) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Textured props (tools/props/*.py): ONE material per prop with an albedo atlas whose alpha is the per-instance paint
// mask (car / scooter body), plus an ORM map (R = baked AO, G = roughness, B = metalness).
// ---------------------------------------------------------------------------------------------
function makeTexturedMaterial(src: THREE.MeshStandardMaterial, tinted: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: src.map, roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap, aoMap: src.aoMap, normalMap: src.normalMap,
    roughness: 1, metalness: 1, aoMapIntensity: 1,
  });
  m.name = `prop_tex:${src.name}`;
  if (src.normalMap) m.normalScale.copy(src.normalScale);
  if (m.map) m.map.anisotropy = Math.max(m.map.anisotropy, 4);
  if (tinted) {
    // instance colour multiplies only where the albedo alpha (paint mask) is set
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <color_fragment>',
        '#if defined( USE_COLOR )\n\tdiffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, sampledDiffuseColor.a );\n#endif\n\tdiffuseColor.a = 1.0;',
      );
      injectWorldLighting(sh);
    };
    m.customProgramCacheKey = () => 'prop_tex_tint_v2';
  }
  return m;
}

/** Merge textured primitives into one geometry (position / normal / uv). */
function mergeTextured(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    const P = g.attributes.position as THREE.BufferAttribute, N = g.attributes.normal as THREE.BufferAttribute | undefined, U = g.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < P.count; i++) {
      const o = (vo + i) * 3;
      pos[o] = P.getX(i); pos[o + 1] = P.getY(i); pos[o + 2] = P.getZ(i);
      if (N) { nrm[o] = N.getX(i); nrm[o + 1] = N.getY(i); nrm[o + 2] = N.getZ(i); } else nrm[o + 1] = 1;
      if (U) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i); }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) idx[io++] = vo + i;
    vo += P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Prototypes (one per prop type)
// ---------------------------------------------------------------------------------------------
interface Part { name: string; geo: THREE.BufferGeometry; mat: THREE.Material; tinted: boolean }
interface Proto {
  name: string;
  parts: Part[];
  hull: Float32Array; // all vertex positions (for resting tilted props on the ground)
  box: THREE.Box3;
  shadow: 0 | 1 | 2; // 0 never, 1 only on high-res shadow maps, 2 always
  lodParts: Part[] | null; // low-poly version for distant instances (`<name>_lod.glb`, or a flat material subset)
}

interface LoadOpts {
  tint?: string | true; // flat GLBs: material recoloured per instance; textured GLBs: use the albedo-alpha paint mask
  palette?: Record<string, number>; // flat GLBs: material name → replacement base colour (sRGB hex)
  keep?: (mat: string, cx: number, cy: number, cz: number) => boolean;
  recentre?: boolean;
  shadow?: 0 | 1 | 2;
  far?: string[]; // flat GLBs: materials kept in the distant low-poly LOD
  lod?: string; // textured GLBs: URL of the `_lod.glb`
}

interface Collected { flat: FlatSrc[]; tex: Map<THREE.Texture, { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[] }> }

async function collectGltf(assets: Assets, url: string, o: LoadOpts): Promise<Collected | null> {
  const gltf = await assets.gltf(url);
  if (!gltf) return null;
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const flat: FlatSrc[] = [];
  const tex: Collected['tex'] = new Map();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    let geo: THREE.BufferGeometry | null = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld); // bake the node transform
    if (o.keep) geo = filterTris(geo, (x, y, z) => o.keep!(mat.name, x, y, z));
    if (!geo) return;
    if (mat.map) {
      const e = tex.get(mat.map) ?? { mat, geos: [] };
      e.geos.push(geo);
      tex.set(mat.map, e);
      return;
    }
    const tint = typeof o.tint === 'string' && mat.name === o.tint;
    const color = safeColor(tint ? new THREE.Color(1, 1, 1) : o.palette?.[mat.name] !== undefined ? new THREE.Color(o.palette[mat.name]) : mat.color.clone());
    let emit = 0;
    const e = mat.emissive;
    if (e && Math.max(e.r, e.g, e.b) > 0) emit = (mat.emissiveIntensity ?? 1) * Math.max(e.r, e.g, e.b) / Math.max(1e-3, Math.max(color.r, color.g, color.b));
    flat.push({ geo, color, pbr: [mat.roughness ?? 0.8, mat.metalness ?? 0, emit, tint ? 1 : 0], mat: mat.name });
  });
  return flat.length || tex.size ? { flat, tex } : null;
}

function partsOf(c: Collected, o: LoadOpts, flatMat: THREE.Material): Part[] {
  const parts: Part[] = [];
  if (c.flat.length) parts.push({ name: 'flat', geo: mergeFlat(c.flat), mat: flatMat, tinted: o.tint !== undefined });
  for (const { mat, geos } of c.tex.values()) {
    const tinted = o.tint !== undefined;
    parts.push({ name: 'tex', geo: mergeTextured(geos), mat: makeTexturedMaterial(mat, tinted), tinted });
  }
  return parts;
}

async function loadProto(assets: Assets, url: string, name: string, flatMat: THREE.Material, o: LoadOpts = {}): Promise<Proto | null> {
  const [c, cl] = await Promise.all([collectGltf(assets, url, o), o.lod ? collectGltf(assets, o.lod, { ...o, keep: undefined }) : Promise.resolve(null)]);
  if (!c) return null;
  const geos = [...c.flat.map((f) => f.geo), ...[...c.tex.values()].flatMap((t) => t.geos)];
  if (o.recentre) {
    const b = new THREE.Box3();
    for (const g of geos) { g.computeBoundingBox(); b.union(g.boundingBox!); }
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    const lodGeos = cl ? [...cl.flat.map((f) => f.geo), ...[...cl.tex.values()].flatMap((t) => t.geos)] : [];
    for (const g of [...geos, ...lodGeos]) g.translate(-cx, -b.min.y, -cz);
  }
  const parts = partsOf(c, o, flatMat);
  let nv = 0;
  for (const g of geos) nv += g.attributes.position.count;
  const hull = new Float32Array(nv * 3);
  let k = 0;
  const box = new THREE.Box3();
  for (const g of geos) {
    const P = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < P.count; i++) { hull[k++] = P.getX(i); hull[k++] = P.getY(i); hull[k++] = P.getZ(i); }
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  }
  let lodParts: Part[] | null = cl ? partsOf(cl, o, flatMat) : null;
  if (!lodParts && o.far) {
    const farSrc = c.flat.filter((f) => o.far!.includes(f.mat ?? ''));
    if (farSrc.length) lodParts = [{ name: 'flat', geo: mergeFlat(farSrc), mat: flatMat, tinted: o.tint !== undefined }];
  }
  return { name, parts, hull, box, shadow: o.shadow ?? 2, lodParts };
}

// ---------------------------------------------------------------------------------------------
// Per-instance LOD instancing
// ---------------------------------------------------------------------------------------------
/** One LOD band: instances whose distance to the camera is ≤ maxDist (and > the previous band's) draw with `parts`. */
export interface LodLevel { parts: Part[]; maxDist: number; shadow: boolean; cull: boolean }

/** Bands for a proto: full model (shadowed / unshadowed) up to lodDist, then the low-poly model, nothing past drawDist. */
function lodLevels(p: Proto, shadowDist: number, drawDist: number, lodDist: number): LodLevel[] {
  const out: LodLevel[] = [];
  const lod = p.lodParts ? Math.min(lodDist, drawDist) : drawDist;
  if (shadowDist > 0) out.push({ parts: p.parts, maxDist: Math.min(shadowDist, lod), shadow: true, cull: false });
  if (lod > shadowDist) out.push({ parts: p.parts, maxDist: lod, shadow: false, cull: true });
  if (p.lodParts && drawDist > lod) {
    if (shadowDist > lod) out.push({ parts: p.lodParts, maxDist: shadowDist, shadow: true, cull: false });
    out.push({ parts: p.lodParts, maxDist: drawDist, shadow: false, cull: true });
  }
  return out;
}

let lodCamera: THREE.Camera | null = null;
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _cv = new THREE.Vector3(), _cq = new THREE.Quaternion(), _sp = new THREE.Sphere();

/**
 * Instanced prop with per-instance LOD. Every instance is re-sorted into its distance band whenever the camera moves
 * (≥ 0.5 m or ≥ ~2°), so a row of scooters switches model bike by bike instead of chunk by chunk. Bands that don't
 * cast shadows are also frustum-culled per instance; shadow-casting bands keep off-screen instances so their shadows
 * don't pop. Cost: one InstancedMesh (draw call) per band and part, O(instances) CPU per camera move.
 * The update runs in updateMatrixWorld (before three.js uploads buffers), using the camera captured from the
 * previous frame's render, so no game-loop hook is needed.
 *
 *     const ip = new InstancedProp('bikes', levels, box, true); ip.addInstance(matrix, color); ...; ip.build(); scene.add(ip);
 */
export class InstancedProp extends THREE.Group {
  private mats: number[] = [];
  private cols: number[] = [];
  private matArr = new Float32Array(0);
  private colArr = new Float32Array(0);
  private cx: number[] = []; private cy: number[] = []; private cz: number[] = []; private cr: number[] = [];
  private bands: { def: LodLevel; meshes: THREE.InstancedMesh[] }[] = [];
  private built = false;
  private last = new Float64Array([NaN, 0, 0, 0, 0, 0, 0]);
  private bc = new THREE.Vector3();
  private br = 1;
  drawCalls = 0;

  constructor(name: string, private levels: LodLevel[], box: THREE.Box3, private tinted: boolean) {
    super();
    this.name = name;
    box.getCenter(this.bc);
    this.br = Math.max(0.05, box.getSize(new THREE.Vector3()).length() / 2);
  }

  get instanceCount(): number { return this.cx.length; }

  addInstance(m: THREE.Matrix4, color?: THREE.Color | null): void {
    const e = m.elements;
    for (let i = 0; i < 16; i++) this.mats.push(e[i]);
    const c = color ?? null;
    this.cols.push(c ? c.r : 1, c ? c.g : 1, c ? c.b : 1);
    _cv.copy(this.bc).applyMatrix4(m);
    const s = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
    this.cx.push(_cv.x); this.cy.push(_cv.y); this.cz.push(_cv.z); this.cr.push(this.br * s);
  }

  /** Lift every instance by f(x, z) (the campus terrain, src/world/terrain.ts); the bands rebuild from these matrices. */
  applyTerrain(f: (x: number, z: number) => number): void {
    for (let i = 0; i < this.cx.length; i++) {
      const dy = f(this.mats[i * 16 + 12], this.mats[i * 16 + 14]);
      if (!dy) continue;
      this.mats[i * 16 + 13] += dy;
      if (this.matArr.length) this.matArr[i * 16 + 13] += dy;
      this.cy[i] += dy;
    }
    this.last[0] = NaN;
    if (this.built) this.refresh(null, true);
  }

  /** World positions (instance origins) — debugging. */
  positions(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.cx.length; i++) out.push([+this.mats[i * 16 + 12].toFixed(1), +this.mats[i * 16 + 13].toFixed(2), +this.mats[i * 16 + 14].toFixed(1)]);
    return out;
  }

  build(): this {
    const n = this.cx.length;
    if (!n) return this;
    this.matArr = new Float32Array(this.mats);
    this.colArr = new Float32Array(this.cols);
    this.levels.forEach((def, li) => {
      const meshes = def.parts.map((p) => {
        const im = new THREE.InstancedMesh(p.geo, p.mat, n);
        im.count = 0;
        im.castShadow = def.shadow;
        im.receiveShadow = true;
        im.matrixAutoUpdate = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (this.tinted && p.tinted) {
          im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
          im.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        im.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
        im.name = `${this.name}:L${li}:${p.name}`;
        super.add(im);
        return im;
      });
      this.bands.push({ def, meshes });
    });
    this.drawCalls = this.bands.reduce((a, b) => a + b.meshes.length, 0);
    // camera capture: a no-draw hook object in the render list
    const hook = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hook.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    hook.geometry.setDrawRange(0, 0);
    hook.frustumCulled = false;
    hook.name = `${this.name}:lodhook`;
    hook.onBeforeRender = (_r, _s, cam) => { if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) lodCamera = cam; };
    super.add(hook);
    this.built = true;
    this.refresh(null);
    return this;
  }

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    if (this.built) this.refresh(lodCamera);
  }

  /** Re-sort instances into bands for this camera (null = everything in the cheapest band, unculled). */
  refresh(cam: THREE.Camera | null, force = false): void {
    let px = 0, py = 0, pz = 0;
    if (cam) {
      cam.updateMatrixWorld();
      _cv.setFromMatrixPosition(cam.matrixWorld);
      cam.getWorldQuaternion(_cq);
      const L = this.last;
      const moved = Number.isNaN(L[0]) || (_cv.x - L[0]) ** 2 + (_cv.y - L[1]) ** 2 + (_cv.z - L[2]) ** 2 > 0.25;
      const turned = Math.abs(_cq.x * L[3] + _cq.y * L[4] + _cq.z * L[5] + _cq.w * L[6]) < 0.99985;
      if (!force && !moved && !turned) return;
      L[0] = _cv.x; L[1] = _cv.y; L[2] = _cv.z; L[3] = _cq.x; L[4] = _cq.y; L[5] = _cq.z; L[6] = _cq.w;
      // camera in this object's space (instances are stored relative to it)
      _inv.copy(this.matrixWorld).invert();
      _cv.applyMatrix4(_inv);
      px = _cv.x; py = _cv.y; pz = _cv.z;
      _pm.multiplyMatrices((cam as THREE.PerspectiveCamera).projectionMatrix, cam.matrixWorldInverse).multiply(this.matrixWorld);
      _frustum.setFromProjectionMatrix(_pm);
    }
    const nb = this.bands.length;
    const counts = new Array<number>(nb).fill(0);
    const mins = Array.from({ length: nb }, () => [Infinity, Infinity, Infinity]);
    const maxs = Array.from({ length: nb }, () => [-Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < this.cx.length; i++) {
      let band = nb - 1;
      if (cam) {
        const d = Math.hypot(this.cx[i] - px, (this.cy[i] - py) * 0.5, this.cz[i] - pz) - this.cr[i] * 0.3;
        band = -1;
        for (let b = 0; b < nb; b++) if (d <= this.bands[b].def.maxDist) { band = b; break; }
        if (band < 0) continue;
        if (this.bands[band].def.cull) {
          _sp.center.set(this.cx[i], this.cy[i], this.cz[i]);
          _sp.radius = this.cr[i];
          if (!_frustum.intersectsSphere(_sp)) continue;
        }
      }
      const k = counts[band]++;
      for (const im of this.bands[band].meshes) {
        im.instanceMatrix.array.set(this.matArr.subarray(i * 16, i * 16 + 16), k * 16);
        if (im.instanceColor) im.instanceColor.array.set(this.colArr.subarray(i * 3, i * 3 + 3), k * 3);
      }
      const mn = mins[band], mx = maxs[band], r = this.cr[i];
      mn[0] = Math.min(mn[0], this.cx[i] - r); mn[1] = Math.min(mn[1], this.cy[i] - r); mn[2] = Math.min(mn[2], this.cz[i] - r);
      mx[0] = Math.max(mx[0], this.cx[i] + r); mx[1] = Math.max(mx[1], this.cy[i] + r); mx[2] = Math.max(mx[2], this.cz[i] + r);
    }
    this.bands.forEach((b, bi) => {
      const n = counts[bi];
      for (const im of b.meshes) {
        // never touch .visible here: N8AO saves/restores visibility around its own scene renders, which also run this
        // update; an empty band is parked out of every frustum instead
        im.count = n;
        if (!n) { im.boundingSphere!.center.set(0, -1e6, 0); im.boundingSphere!.radius = 0; continue; }
        im.instanceMatrix.clearUpdateRanges();
        im.instanceMatrix.addUpdateRange(0, n * 16);
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) {
          im.instanceColor.clearUpdateRanges();
          im.instanceColor.addUpdateRange(0, n * 3);
          im.instanceColor.needsUpdate = true;
        }
        const mn = mins[bi], mx = maxs[bi];
        im.boundingSphere!.center.set((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2);
        im.boundingSphere!.radius = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2;
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Procedural geometry builder (station furniture, pit, notice boards) — emits color + pbr attributes.
// ---------------------------------------------------------------------------------------------
class VBuilder {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; pbr: number[] = []; uv: number[] = []; idx: number[] = [];
  private c = new THREE.Color(1, 1, 1);
  private p: PBR4 = [0.8, 0, 0, 0];
  private xf: THREE.Matrix4 | null = null;
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();
  private n = new THREE.Vector3();

  set(color: THREE.ColorRepresentation, rough = 0.8, metal = 0, emit = 0): this { safeColor(this.c.set(color)); this.p = [rough, metal, emit, 0]; return this; }
  transform(m: THREE.Matrix4 | null): this { this.xf = m; if (m) this.nm.getNormalMatrix(m); return this; }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, w = 0): number {
    this.v.set(x, y, z); this.n.set(nx, ny, nz);
    if (this.xf) { this.v.applyMatrix4(this.xf); this.n.applyMatrix3(this.nm).normalize(); }
    this.pos.push(this.v.x, this.v.y, this.v.z);
    this.nrm.push(this.n.x, this.n.y, this.n.z);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.pbr.push(...this.p);
    this.uv.push(u, w);
    return this.pos.length / 3 - 1;
  }

  /** Box centred at (cx,cy,cz) with size (sx,sy,sz), rotated `yaw` about Y. Optional face UV rect for +Z face. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw = 0, uvFront?: [number, number, number, number]): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const F: [number, number, number, [number, number, number][]][] = [
      [1, 0, 0, [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [-1, 0, 0, [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [0, 1, 0, [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [0, -1, 0, [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [0, 0, 1, [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [0, 0, -1, [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    ];
    for (const [nx, ny, nz, vs] of F) {
      const front = nz === 1 && uvFront;
      const ids = vs.map(([x, y, z], i) => {
        const u = front ? (i === 1 || i === 2 ? uvFront![2] : uvFront![0]) : 0.001;
        const w = front ? (i >= 2 ? uvFront![3] : uvFront![1]) : 0.001;
        return this.vert(cx + x * cs + z * sn, cy + y, cz - x * sn + z * cs, nx * cs + nz * sn, ny, -nx * sn + nz * cs, u, w);
      });
      this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  }

  cyl(cx: number, y0: number, cz: number, r: number, h: number, seg = 10): void {
    const base = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
      this.vert(cx + x * r, y0, cz + z * r, x, 0, z);
      this.vert(cx + x * r, y0 + h, cz + z * r, x, 0, z);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }

  /** Lumpy mound (sand/soil pile). */
  mound(cx: number, cz: number, r: number, h: number, seed: number, seg = 12): void {
    const R = rng(seed);
    const top = this.vert(cx, h, cz, 0, 1, 0);
    const ring: number[] = [];
    const rr: number[] = [];
    for (let i = 0; i < seg; i++) rr.push(r * (0.75 + R() * 0.45));
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, k = rr[i % seg];
      const x = Math.cos(a), z = Math.sin(a);
      const s = Math.hypot(h, k);
      ring.push(this.vert(cx + x * k, 0.02, cz + z * k, (x * h) / s, k / s, (z * h) / s));
    }
    for (let i = 0; i < seg; i++) this.idx.push(top, ring[i + 1], ring[i]);
  }

  /** Flat horizontal quad (decal-ish patch). */
  patch(cx: number, cz: number, sx: number, sz: number, yaw: number, y: number): void {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const ids = ([[-1, 1], [1, 1], [1, -1], [-1, -1]] as V2[]).map(([a, b]) => {
      const x = (a * sx) / 2, z = (b * sz) / 2;
      return this.vert(cx + x * cs + z * sn, y, cz - x * sn + z * cs, 0, 1, 0);
    });
    this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }

  get empty(): boolean { return this.idx.length === 0; }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('pbr', new THREE.Float32BufferAttribute(this.pbr, 4));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function noticeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 384;
  const g = c.getContext('2d')!;
  const R = rng(1234);
  g.fillStyle = '#9a7a52'; g.fillRect(0, 0, 512, 384);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${60 + R() * 60},${40 + R() * 40},20,${0.15 + R() * 0.2})`; g.fillRect(R() * 512, R() * 384, 2, 2); }
  g.fillStyle = '#1d2f6f'; g.fillRect(0, 0, 512, 54);
  g.fillStyle = '#f4f1e8'; g.font = '700 34px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('NOTICE BOARD', 256, 28);
  const papers = ['#f7f4ea', '#fff6a8', '#d9ecff', '#ffd6d6', '#e2f5d8', '#f7f4ea'];
  for (let i = 0; i < 9; i++) {
    const w = 90 + R() * 60, h = 100 + R() * 70, x = 14 + (i % 4) * 124 + R() * 12, y = 66 + Math.floor(i / 4) * 150 + R() * 14;
    g.save(); g.translate(x + w / 2, y + h / 2); g.rotate((R() - 0.5) * 0.12);
    g.fillStyle = papers[i % papers.length]; g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = 'rgba(40,40,60,0.55)';
    for (let l = 0; l < 7; l++) g.fillRect(-w / 2 + 8, -h / 2 + 16 + l * 12, (w - 16) * (0.5 + R() * 0.5), 3);
    g.fillStyle = '#c0392b'; g.beginPath(); g.arc(0, -h / 2 + 6, 4, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // the evening it all went wrong
  g.save(); g.translate(380, 250); g.rotate(0.06);
  g.fillStyle = '#b3261e'; g.fillRect(-80, -52, 160, 104);
  g.fillStyle = '#fff'; g.font = '800 26px Arial, sans-serif'; g.fillText('EVACUATE', 0, -18);
  g.font = '600 15px Arial, sans-serif'; g.fillText('ASSEMBLE AT MAIN GATE', 0, 12); g.fillText('DO NOT ENTER B-BLOCK', 0, 34);
  g.restore();
  g.save(); g.translate(120, 300); g.rotate(-0.05);
  g.fillStyle = '#f7f4ea'; g.fillRect(-70, -50, 140, 100);
  g.fillStyle = '#111'; g.font = '800 22px Arial, sans-serif'; g.fillText('MISSING', 0, -26);
  g.fillStyle = '#888'; g.fillRect(-26, -12, 52, 44);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------------------------
const yawTo = (dx: number, dz: number): number => Math.atan2(dx, dz);
/** local (lx, lz) in a frame at (x,z) rotated by yaw → world */
function local(x: number, z: number, yaw: number, lx: number, lz: number): V2 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}
function rectPoly(x: number, z: number, yaw: number, w: number, l: number): V2[] {
  return [local(x, z, yaw, -w / 2, -l / 2), local(x, z, yaw, w / 2, -l / 2), local(x, z, yaw, w / 2, l / 2), local(x, z, yaw, -w / 2, l / 2)];
}
function distToPoly(x: number, z: number, poly: V2[]): number {
  if (pointInPoly(x, z, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    d = Math.min(d, distToSegment(x, z, a[0], a[1], b[0], b[1]));
  }
  return d;
}
function polyline(pts: V2[]): { at: (s: number) => { p: V2; d: V2 }; length: number } {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = L[L.length - 1];
  const at = (s: number) => {
    s = Math.max(0, Math.min(length, s));
    let i = 1;
    while (i < L.length - 1 && L[i] < s) i++;
    const a = pts[i - 1], b = pts[i];
    const seg = L[i] - L[i - 1] || 1;
    const f = (s - L[i - 1]) / seg;
    const d: V2 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] as V2, d };
  };
  return { at, length };
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------
interface Inst { m: THREE.Matrix4; x: number; z: number; color: THREE.Color | null }
interface Foot { ox: number; oz: number; w: number; l: number; h: number; lift: number } // local footprint centre offset + size
interface Placed { x: number; z: number; yaw: number; cx: number; cz: number; w: number; l: number; h: number; y: number }
/** noClear: ignore gate throats + road corridors; laneOk: ignore only road corridors (gate throats still kept clear). */
interface FreeOpts { offRoad?: boolean; noClear?: boolean; laneOk?: boolean; noReserve?: boolean }
interface PlaceOpts extends FreeOpts {
  y?: number; pitch?: number; roll?: number; color?: THREE.ColorRepresentation; scale?: number;
  margin?: number; force?: boolean;
  solid?: { shape: 'rect' | 'circle' | 'seg'; surface: SurfaceKind; h?: number; pad?: number } | null;
}
interface Capsule { a: V2; b: V2; hw: number; minX: number; maxX: number; minZ: number; maxZ: number }

export const CAR_PAINT = [0xe9e9e6, 0xb9bdc2, 0xa3161a, 0x1f4aa0, 0x5d6166]; // white, silver, red, blue, grey
export const SCOOTER_PAINT = [0xe8e8e4, 0x17181b, 0xa81c1c, 0x1f3f8f, 0x7d8288, 0x5b1a24];

class Dresser {
  group = new THREE.Group();
  anchors = new Map<string, THREE.Object3D>();
  private sets = new Map<string, Inst[]>();
  private occ = new StaticCollision(); // footprints of decor without collision (avoid prop-on-prop overlap)
  private reserved: { x: number; z: number; r: number }[] = [];
  private gateRects: V2[][] = [];
  private caps: Capsule[] = [];
  private spawnPts: V2[] = [];
  private staticSrc: FlatSrc[] = [];
  private boards = new VBuilder();
  private roadVehicles: { road: number; s: number; side: number }[] = [];
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  stats = { rejected: 0 };

  constructor(private protos: Map<string, Proto>, private col: StaticCollision, private flatMat: THREE.Material, private quality: QualityProfile) {
    this.group.name = 'props';
    this.buildClearZones();
  }

  // ------------------------------------------------------------------ clear zones / free tests
  private buildClearZones(): void {
    for (const g of GATES) {
      const f = gateFrame(g);
      const D = 6.5;
      this.gateRects.push([
        [g.a[0] - f.n[0] * D, g.a[1] - f.n[1] * D], [g.b[0] - f.n[0] * D, g.b[1] - f.n[1] * D],
        [g.b[0] + f.n[0] * D, g.b[1] + f.n[1] * D], [g.a[0] + f.n[0] * D, g.a[1] + f.n[1] * D],
      ]);
    }
    const addChain = (pts: V2[], hw: number) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        this.caps.push({ a, b, hw, minX: Math.min(a[0], b[0]) - hw, maxX: Math.max(a[0], b[0]) + hw, minZ: Math.min(a[1], b[1]) - hw, maxZ: Math.max(a[1], b[1]) + hw });
      }
    };
    for (const r of ROADS) {
      if (r.median) {
        const off = r.median / 2 + (r.width - r.median) / 4;
        const { left, right } = polylineToStrip(r.pts, off * 2);
        addChain(left, 1.0);
        addChain(right, 1.0);
      } else addChain(r.pts, Math.min(1.5, Math.max(0.5, r.width / 2 - 3.3)));
    }
    // ORR service roads keep a lane open
    for (const off of [ORR.serviceOffset, -ORR.serviceOffset]) addChain([orrPoint(-200, off), orrPoint(300, off)], 1.0);
    for (const z of SPAWN_ZONES) for (const p of z.pts) this.spawnPts.push(p);
  }

  inClear(x: number, z: number, r: number, roads = true): boolean {
    for (const rect of this.gateRects) if (distToPoly(x, z, rect) < r) return true;
    if (!roads) return false;
    for (const c of this.caps) {
      if (x + r < c.minX || x - r > c.maxX || z + r < c.minZ || z - r > c.maxZ) continue;
      if (distToSegment(x, z, c.a[0], c.a[1], c.b[0], c.b[1]) < c.hw + r) return true;
    }
    return false;
  }

  onRoad(x: number, z: number, r: number): boolean {
    for (const rd of ROADS) for (let i = 1; i < rd.pts.length; i++) {
      const a = rd.pts[i - 1], b = rd.pts[i];
      if (distToSegment(x, z, a[0], a[1], b[0], b[1]) < rd.width / 2 + r) return true;
    }
    return false;
  }

  free(x: number, z: number, r: number, o: FreeOpts = {}): boolean {
    if (this.col.blocked(x, z, r) || this.occ.blocked(x, z, r)) return false;
    if (!o.noReserve) for (const s of this.reserved) if ((x - s.x) ** 2 + (z - s.z) ** 2 < (s.r + r) ** 2) return false;
    for (const p of this.spawnPts) if ((x - p[0]) ** 2 + (z - p[1]) ** 2 < (3.5 + r) ** 2) return false;
    if (!o.noClear && this.inClear(x, z, r, !o.laneOk)) return false;
    if (o.offRoad && this.onRoad(x, z, r)) return false;
    return true;
  }

  /** Stadium test of an oriented w×l footprint centred at (x,z). */
  rectFree(x: number, z: number, yaw: number, w: number, l: number, margin: number, o: FreeOpts = {}): boolean {
    const long = Math.max(w, l), short = Math.min(w, l);
    const r = short / 2 + margin;
    const n = Math.max(1, Math.ceil((long - short) / (short * 0.7)) + 1);
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - short);
      const [px, pz] = w >= l ? local(x, z, yaw, f, 0) : local(x, z, yaw, 0, f);
      if (!this.free(px, pz, r, o)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ core add
  /** Footprint of a proto under a tilt (local frame, before yaw). */
  footprint(name: string, pitch = 0, roll = 0, scale = 1): Foot | null {
    const p = this.protos.get(name);
    if (!p) return null;
    if (!pitch && !roll) {
      const b = p.box;
      return { ox: ((b.min.x + b.max.x) / 2) * scale, oz: ((b.min.z + b.max.z) / 2) * scale, w: (b.max.x - b.min.x) * scale, l: (b.max.z - b.min.z) * scale, h: b.max.y * scale, lift: 0 };
    }
    this.e.set(pitch, 0, roll, 'YXZ');
    const m = new THREE.Matrix4().makeRotationFromEuler(this.e).elements;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const H = p.hull;
    for (let i = 0; i < H.length; i += 3) {
      const x = H[i], y = H[i + 1], z = H[i + 2];
      const X = m[0] * x + m[4] * y + m[8] * z, Y = m[1] * x + m[5] * y + m[9] * z, Z = m[2] * x + m[6] * y + m[10] * z;
      if (X < minX) minX = X; if (X > maxX) maxX = X;
      if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
      if (Z < minZ) minZ = Z; if (Z > maxZ) maxZ = Z;
    }
    return { ox: ((minX + maxX) / 2) * scale, oz: ((minZ + maxZ) / 2) * scale, w: (maxX - minX) * scale, l: (maxZ - minZ) * scale, h: (maxY - minY) * scale, lift: -minY * scale };
  }

  /**
   * Place a prop. Unless `force`, the footprint must be free. Registers collision per `solid`
   * (default: none) and decor footprints in the private occupancy map.
   */
  place(name: string, x: number, z: number, yaw: number, o: PlaceOpts = {}): Placed | null {
    const f = this.footprint(name, o.pitch, o.roll, o.scale);
    if (!f) return null;
    const [cx, cz] = local(x, z, yaw, f.ox, f.oz);
    if (!o.force && !this.rectFree(cx, cz, yaw, f.w, f.l, o.margin ?? 0.1, o)) { this.stats.rejected++; return null; }
    const y = (o.y ?? 0) + f.lift;
    this.e.set(o.pitch ?? 0, yaw, o.roll ?? 0, 'YXZ');
    this.q.setFromEuler(this.e);
    const s = o.scale ?? 1;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(s, s, s));
    const setName = this.variant(name, x, z);
    const list = this.sets.get(setName) ?? [];
    list.push({ m, x, z, color: o.color !== undefined ? safeColor(new THREE.Color(o.color)) : null });
    this.sets.set(setName, list);
    const P: Placed = { x, z, yaw, cx, cz, w: f.w, l: f.l, h: f.h + (o.y ?? 0), y };
    const sol = o.solid;
    if (sol) {
      const h = sol.h ?? P.h;
      const pad = sol.pad ?? 0;
      if (sol.shape === 'circle') this.col.addCircle(cx, cz, Math.max(f.w, f.l) / 2 + pad, h, sol.surface, 'prop');
      else if (sol.shape === 'rect') this.col.addPolygon(rectPoly(cx, cz, yaw, f.w + pad * 2, f.l + pad * 2), h, sol.surface, 'prop');
      else {
        const along = f.l >= f.w;
        const len = Math.max(f.w, f.l), th = Math.min(f.w, f.l) + pad * 2;
        const half = Math.max(0.01, len / 2 - th / 2);
        const a = along ? local(cx, cz, yaw, 0, -half) : local(cx, cz, yaw, -half, 0);
        const b = along ? local(cx, cz, yaw, 0, half) : local(cx, cz, yaw, half, 0);
        this.col.addSegment(a, b, th, h, sol.surface, 'prop');
      }
    } else {
      this.occ.addPolygon(rectPoly(cx, cz, yaw, f.w, f.l), Math.max(0.2, P.h), 'wood', 'decor');
    }
    return P;
  }

  /**
   * Visual variant of a placed prop (footprint and collision stay the base prop's): ~40 % of the parked scooters are
   * commuter motorcycles and ~40 % of the cars are sedans. Hashed from the position, so it is deterministic and
   * independent of placement order.
   */
  private variant(name: string, x: number, z: number): string {
    const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    if (name === 'bike' && h < 0.4 && this.protos.has('motorbike')) return 'motorbike';
    if (name === 'car' && h < 0.4 && this.protos.has('car_sedan')) return 'car_sedan';
    return name;
  }

  addStatic(geo: THREE.BufferGeometry): void { this.staticSrc.push({ geo }); }

  protoGeo(name: string): THREE.BufferGeometry | null {
    const p = this.protos.get(name);
    return p?.parts.find((q) => q.name === 'flat')?.geo ?? null;
  }

  // ------------------------------------------------------------------ finalize: instanced meshes
  finish(): void {
    const shadowsOn = this.quality.shadowMapSize > 0;
    const hiShadow = this.quality.shadowMapSize >= 4096;
    let calls = 0, instances = 0;
    for (const [name, list] of this.sets) {
      const proto = this.protos.get(name);
      if (!proto || !list.length) continue;
      const [, shadowDist, dist] = CHUNK[name] ?? CHUNK_DEFAULT;
      const casts = shadowsOn && (proto.shadow === 2 || (proto.shadow === 1 && hiShadow)) && shadowDist > 0;
      const levels = lodLevels(proto, casts ? shadowDist : 0, dist, LOD_DIST[name] ?? Infinity);
      const ip = new InstancedProp(`prop:${name}`, levels, proto.box, proto.parts.some((p) => p.tinted));
      for (const it of list) ip.addInstance(it.m, it.color);
      ip.build();
      this.group.add(ip);
      calls += ip.drawCalls;
      instances += list.length;
    }
    if (this.staticSrc.length) {
      const mesh = new THREE.Mesh(mergeFlat(this.staticSrc), this.flatMat);
      mesh.castShadow = shadowsOn; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'prop:static';
      this.group.add(mesh);
      calls++;
    }
    if (!this.boards.empty) {
      const mesh = new THREE.Mesh(this.boards.geometry(), new THREE.MeshStandardMaterial({ map: noticeTexture(), roughness: 0.85 }));
      mesh.castShadow = shadowsOn; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'prop:noticeboards';
      this.group.add(mesh);
      calls++;
    }
    this.group.userData.stats = { meshes: calls, instances, rejected: this.stats.rejected, counts: Object.fromEntries([...this.sets].map(([k, v]) => [k, v.length])) };
  }

  // ==================================================================================================
  // Dressing passes
  // ==================================================================================================

  /**
   * Sandbag step stacks (layout STEP_STACKS): each tier is one flat collision box at its top bag layer, two bags deep,
   * so gate and wall tops are reached in ≤ 1.3 m climbs. Placed before the scatter passes, which then keep clear.
   */
  stepStacks(): void {
    const f = this.footprint('stackbags');
    if (!f) return;
    for (const st of STEP_STACKS) {
      const u: V2 = [-st.in[1], st.in[0]];
      const yaw = Math.atan2(-u[1], u[0]); // bag length (local X) along the wall
      st.layers.forEach((layers, k) => {
        const d0 = st.gap + k * 2 * f.l;
        for (let r = 0; r < 2; r++) for (let l = 0; l < layers; l++) {
          const d = d0 + f.l * (r + 0.5);
          this.place('stackbags', st.at[0] + st.in[0] * d, st.at[1] + st.in[1] * d, yaw + (((k * 7 + r * 3 + l) % 5) - 2) * 0.012, { force: true, y: l * 0.57 });
        }
        const dc = d0 + f.l;
        this.col.addPolygon(rectPoly(st.at[0] + st.in[0] * dc, st.at[1] + st.in[1] * dc, yaw, f.w, 2 * f.l), f.h + (layers - 1) * 0.57, 'ground', 'prop');
      });
    }
  }

  globe(): void {
    const [gx, gz] = GLOBE_POS;
    const main = GATES.find((g) => g.id === 'main') ?? GATES[0];
    const yaw = main ? yawTo((main.a[0] + main.b[0]) / 2 - gx, (main.a[1] + main.b[1]) / 2 - gz) : 0;
    if (!this.place('globe', gx, gz, yaw, { force: true, y: GLOBE_Y })) return;
    if (!this.col.blocked(gx, gz, 0.05, (t) => t === 'globe')) this.col.addCircle(gx, gz, 1.55, 3.2, 'metal', 'prop', GLOBE_Y);
    this.reserved.push({ x: gx, z: gz, r: 2.6 });
  }

  // ------------------------------------------------------------------ stations
  /**
   * Stations: STATIONS[].pos is where the player stands to interact; it is kept free (the nav grid cell stays open)
   * and the prop is set ~1.4 m behind it, front facing the player. The anchor sits above the prop.
   * A station with a floor height (StationDef.y: a storey, the MRD plinth, the parking deck) is fitted inside its own
   * storey: walls and furniture count only within head height of that floor, and the prop must stand on it.
   */
  stations(): void {
    const staticB = new VBuilder();
    const FOOT: Record<string, [number, number, number]> = { ammo: [1.95, 0.56, 1.4], health: [1.05, 0.8, 1.45], weapon: [1.42, 0.56, 1.45], repair: [1.25, 0.65, 1.4], grenade: [0.9, 0.56, 1.35] }; // w, depth, back
    for (const s of STATIONS) {
      let [x, z] = s.pos;
      const storey = s.y !== undefined;
      // floor in the flat-authored frame (applyTerrain lifts props, collision included, afterwards)
      const fy = storey ? s.y! - liftY(x, z) : 0;
      const blocked = storey ? (px: number, pz: number, r: number) => this.col.blockedBand(px, pz, r, fy + 0.1, fy + 1.9) : (px: number, pz: number, r: number) => this.col.blocked(px, pz, r);
      if (blocked(x, z, 0.4)) {
        const q = this.nudge(x, z, 0.45, blocked);
        if (q) {
          console.warn(`[props] station ${s.id} at (${x}, ${z}) is inside geometry; using (${q[0].toFixed(1)}, ${q[1].toFixed(1)})`);
          [x, z] = q;
        }
      }
      const yaw0 = s.face ?? this.faceAway(x, z, blocked);
      const [fw, fd, back0] = FOOT[s.kind] ?? FOOT.ammo;
      let px = x, pz = z, yaw = yaw0;
      let found = false;
      // behind the standing spot (as seen facing away from walls) first, then other directions; the prop always faces the spot
      search: for (const turn of [0, 0.5, -0.5, 1, -1, 1.57, -1.57, 2.2, -2.2, Math.PI]) {
        const yw = yaw0 + turn, fx = Math.sin(yw), fz = Math.cos(yw);
        for (const back of [back0, back0 - 0.15, back0 - 0.3]) {
          for (const side of [0, 0.6, -0.6]) {
            const cx = x - fx * back + fz * side, cz = z - fz * back - fx * side;
            const ok = storey ? this.storeyRectFree(cx, cz, yw, fw, fd, 0.05, fy) : this.rectFree(cx, cz, yw, fw, fd, 0.05, { noClear: true, noReserve: true });
            if (ok) { px = cx; pz = cz; yaw = yw; found = true; break search; }
          }
        }
      }
      if (!found) console.warn(`[props] station ${s.id}: no room behind the standing spot; prop placed on it`);
      let top = 1;
      if (s.kind === 'ammo') top = this.ammoStation(px, pz, yaw, fy);
      else if (s.kind === 'health') top = this.healthStation(staticB, px, pz, yaw, fy);
      else if (s.kind === 'weapon') top = this.weaponStation(staticB, s, px, pz, yaw, fy);
      else if (s.kind === 'grenade') top = this.grenadeStation(staticB, px, pz, yaw, fy);
      else top = this.repairStation(staticB, px, pz, yaw, fy);
      this.col.addPolygon(rectPoly(px, pz, yaw, fw, fd), s.kind === 'weapon' ? 2.0 : top + 0.05, (s.kind === 'weapon' && s.item === 'smg') || s.kind === 'ammo' || s.kind === 'grenade' ? 'wood' : 'metal', 'prop', fy);
      const anchor = new THREE.Object3D();
      anchor.name = `station:${s.id}`;
      anchor.position.set(px, fy + top + 0.45, pz);
      anchor.rotation.y = yaw;
      anchor.userData = { stationId: s.id, kind: s.kind, item: s.item ?? null, stand: [x, z] as V2 };
      anchor.updateMatrix();
      this.group.add(anchor);
      this.anchors.set(s.id, anchor);
      this.reserved.push({ x: px, z: pz, r: 1.2 }, { x, z, r: 1.1 });
    }
    if (!staticB.empty) this.addStatic(staticB.geometry());
  }

  private nudge(x: number, z: number, r: number, blocked = (px: number, pz: number, rr: number) => this.col.blocked(px, pz, rr)): V2 | null {
    for (let d = 0.3; d < 9; d += 0.3) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
        if (!blocked(px, pz, r)) return [px, pz];
      }
    }
    return null;
  }

  /**
   * rectFree for a footprint on a storey floor at fy: clear of every solid within head height of that floor (walls,
   * desks, benches, other stations) and standing on the floor, not over a stairwell or a drop.
   */
  private storeyRectFree(x: number, z: number, yaw: number, w: number, l: number, margin: number, fy: number): boolean {
    const long = Math.max(w, l), short = Math.min(w, l);
    const r = short / 2 + margin;
    const n = Math.max(1, Math.ceil((long - short) / (short * 0.7)) + 1);
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - short);
      const [px, pz] = w >= l ? local(x, z, yaw, f, 0) : local(x, z, yaw, 0, f);
      if (this.col.blockedBand(px, pz, r, fy + 0.1, fy + 1.9)) return false;
    }
    for (const [sx, sz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]] as V2[]) {
      const [px, pz] = local(x, z, yaw, sx * w, sz * l);
      if (Math.abs(this.col.groundAt(px, pz, fy + 0.3) - fy) > 0.15) return false;
    }
    return true;
  }

  /** Yaw that faces away from nearby walls, else toward the nearest road. */
  private faceAway(x: number, z: number, blocked = (px: number, pz: number, r: number) => this.col.blocked(px, pz, r)): number {
    let bx = 0, bz = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
      for (const d of [1.0, 1.8, 2.8]) if (blocked(x + dx * d, z + dz * d, 0.15)) { bx += dx / d; bz += dz / d; }
    }
    if (Math.hypot(bx, bz) > 0.05) return yawTo(-bx, -bz);
    let best = Infinity, px = x, pz = z + 1;
    for (const r of ROADS) for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      const qx = a[0] + dx * t, qz = a[1] + dz * t, d = Math.hypot(qx - x, qz - z);
      if (d < best) { best = d; px = qx; pz = qz; }
    }
    return best < 40 && best > 0.3 ? yawTo(px - x, pz - z) : 0;
  }

  private ammoStation(x: number, z: number, yaw: number, fy = 0): number {
    const a = local(x, z, yaw, -0.47, 0.0);
    const c = local(x, z, yaw, 0.48, 0.02);
    this.place('ammo', a[0], a[1], yaw + 0.03, { force: true, y: fy });
    this.place('ammo', a[0] + 0.01, a[1] - 0.01, yaw - 0.1, { force: true, y: fy + 0.345 });
    this.place('ammo', c[0], c[1], yaw + 0.07, { force: true, y: fy });
    return 0.7;
  }

  private healthStation(b: VBuilder, x: number, z: number, yaw: number, fy = 0): number {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, fy, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    b.transform(m);
    b.set(0xd9dcdf, 0.4, 0.6); // steel folding table
    b.box(0, 0.74, 0, 0.95, 0.035, 0.58);
    for (const [lx, lz] of [[-0.43, -0.25], [0.43, -0.25], [-0.43, 0.25], [0.43, 0.25]] as V2[]) b.box(lx, 0.36, lz, 0.035, 0.72, 0.035);
    b.box(0, 0.2, 0, 0.86, 0.025, 0.5);
    b.set(0xf2f2f0, 0.6, 0); // cloth
    b.box(0, 0.762, 0, 0.9, 0.008, 0.54);
    // red-cross sign on a pole behind
    b.set(0x6b7079, 0.45, 0.6);
    b.box(0.32, 0.8, -0.34, 0.04, 1.6, 0.04);
    b.set(0xf4f4f2, 0.5, 0);
    b.box(0.32, 1.45, -0.32, 0.46, 0.46, 0.025);
    b.set(0xc8161d, 0.5, 0);
    b.box(0.32, 1.45, -0.305, 0.34, 0.1, 0.012);
    b.box(0.32, 1.45, -0.305, 0.1, 0.34, 0.012);
    b.transform(null);
    const k1 = local(x, z, yaw, -0.12, 0.05);
    this.place('medkit', k1[0], k1[1], yaw + 0.1, { force: true, y: fy + 0.767 });
    const k2 = local(x, z, yaw, 0.26, 0.08);
    this.place('medkit', k2[0], k2[1], yaw - 0.4, { force: true, y: fy + 0.767, pitch: -HALF_PI });
    return 1.9;
  }

  private weaponStation(b: VBuilder, s: StationDef, x: number, z: number, yaw: number, fy = 0): number {
    const tone = s.item === 'rifle' ? 0x4b5320 : s.item === 'smg' ? 0x7a5230 : 0x46525e;
    const wood = s.item === 'smg';
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, fy, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    b.transform(m);
    b.set(tone, wood ? 0.75 : 0.5, wood ? 0 : 0.55);
    b.box(0, 0.05, -0.02, 1.34, 0.1, 0.52); // plinth
    b.box(-0.64, 1.0, -0.02, 0.06, 1.9, 0.5); // sides
    b.box(0.64, 1.0, -0.02, 0.06, 1.9, 0.5);
    b.box(0, 1.96, -0.02, 1.4, 0.07, 0.54); // top
    b.box(0, 1.0, -0.25, 1.26, 1.86, 0.035); // back
    b.box(0, 0.72, -0.03, 1.22, 0.035, 0.44); // shelf
    b.set(0x2a2d31, 0.4, 0.8);
    for (const lx of [-0.34, 0.34]) { b.box(lx, 1.2, -0.13, 0.035, 0.035, 0.22); b.box(lx, 1.23, -0.03, 0.035, 0.08, 0.035); }
    b.set(0xefe9d8, 0.6, 0);
    b.box(0, 1.78, -0.23, 0.9, 0.13, 0.01); // label strip
    b.set(0x3b4a2a, 0.8, 0);
    b.box(-0.3, 0.8, 0.02, 0.28, 0.13, 0.16); // ammo boxes on the shelf
    b.box(-0.02, 0.8, 0.0, 0.26, 0.13, 0.15);
    b.box(-0.17, 0.93, 0.01, 0.27, 0.13, 0.16);
    b.set(0x9c1f1f, 0.6, 0);
    b.box(0.32, 0.82, 0.02, 0.22, 0.18, 0.22);
    b.transform(null);
    // the weapon, lying across the pegs, side profile toward the viewer
    const w = this.protos.get(`w_${s.item}`);
    const g = this.protoGeo(`w_${s.item}`);
    if (w && g) {
      const c = new THREE.Vector3();
      w.box.getCenter(c);
      const mw = new THREE.Matrix4()
        .multiply(m)
        .multiply(new THREE.Matrix4().makeTranslation(0, 1.33, -0.09))
        .multiply(new THREE.Matrix4().makeRotationY(-HALF_PI))
        .multiply(new THREE.Matrix4().makeScale(1.15, 1.15, 1.15))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      const gg = g.clone();
      gg.applyMatrix4(mw);
      this.addStatic(gg);
    }
    return 2.0;
  }

  /** Open olive crate with a tray of eight frags on top (the game's own grenade model, merged into the static mesh). */
  private grenadeStation(b: VBuilder, x: number, z: number, yaw: number, fy = 0): number {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, fy, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    b.transform(m);
    b.set(0x4d5a32, 0.85, 0); // crate
    b.box(0, 0.2, 0, 0.84, 0.4, 0.52);
    b.set(0x39432a, 0.8, 0.1); // end battens and rim
    for (const lx of [-0.4, 0.4]) b.box(lx, 0.2, 0, 0.05, 0.42, 0.54);
    b.box(0, 0.395, 0.25, 0.84, 0.03, 0.03);
    b.box(0, 0.395, -0.25, 0.84, 0.03, 0.03);
    b.set(0xd9d2ae, 0.7, 0); // stencilled label
    b.box(0, 0.24, 0.262, 0.46, 0.09, 0.006);
    b.set(0x7a3b1c, 0.7, 0);
    b.box(0, 0.24, 0.263, 0.08, 0.05, 0.006);
    b.set(0x26291f, 0.9, 0); // foam tray
    b.box(0, 0.405, 0, 0.74, 0.02, 0.42);
    b.transform(null);
    const src = grenadeAssets().geometry;
    const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    let k = 0;
    for (const lz of [-0.1, 0.1]) for (const lx of [-0.27, -0.09, 0.09, 0.27]) {
      e.set(0, 0.7 + k * 1.9, 0);
      q.setFromEuler(e);
      p.set(lx, 0.415 + 0.0625, lz);
      const g = src.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, new THREE.Matrix4().compose(p, q, one)));
      this.addStatic(g);
      k++;
    }
    return 0.56;
  }

  private repairStation(b: VBuilder, x: number, z: number, yaw: number, fy = 0): number {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, fy, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    b.transform(m);
    b.set(0x5a4632, 0.8, 0);
    b.box(0, 0.42, 0, 1.2, 0.06, 0.6);
    for (const [lx, lz] of [[-0.55, -0.25], [0.55, -0.25], [-0.55, 0.25], [0.55, 0.25]] as V2[]) b.box(lx, 0.2, lz, 0.06, 0.4, 0.06);
    b.set(0xb3261e, 0.45, 0.5);
    b.box(-0.2, 0.55, 0, 0.5, 0.2, 0.25);
    b.set(0x777c82, 0.35, 0.8);
    b.box(0.3, 0.47, 0.05, 0.3, 0.04, 0.05);
    b.transform(null);
    return 0.6;
  }

  // ------------------------------------------------------------------ main gate: inside "last line", outside forecourt
  /** Entry-road frame at the main gate: (a = metres inward from the gate line, o = lateral, + = right of inbound). */
  private gateRoadFrame(): { at: (a: number, o: number) => { x: number; z: number; face: number }; road: (typeof ROADS)[number]; laneFree: (x: number, z: number, yaw: number, w: number, l: number) => boolean } | null {
    const g = GATES.find((q) => q.id === 'main');
    const road = ROADS.find((r) => r.id === 'entry');
    if (!g || !road) return null;
    const f = gateFrame(g);
    const pl = polyline(road.pts);
    let sGate = 0, best = Infinity;
    for (let s = 0; s <= pl.length; s += 0.25) {
      const { p } = pl.at(s);
      const d = Math.abs((p[0] - f.mid[0]) * f.n[0] + (p[1] - f.mid[1]) * f.n[1]);
      if (d < best) { best = d; sGate = s; }
    }
    const { d: d0 } = pl.at(sGate);
    const sgn = d0[0] * f.n[0] + d0[1] * f.n[1] > 0 ? 1 : -1; // +s is inward?
    const at = (a: number, o: number) => {
      const { p, d } = pl.at(sGate + sgn * a);
      const Fx = -d[0] * sgn, Fz = -d[1] * sgn; // toward the gate
      const lx = -Fz, lz = Fx; // yaw(L) = yaw(F) − 90°, so +o is to the right when facing the gate
      return { x: p[0] + lx * o, z: p[1] + lz * o, face: yawTo(Fx, Fz) };
    };
    // protected band in each carriageway: everything between the divider-side scooter rows and the kerb
    const cw = (road.width - (road.median ?? 0)) / 2;
    const bandIn = (road.median ?? 0) / 2 + 2.0, bandOut = (road.median ?? 0) / 2 + cw;
    const mid = (bandIn + bandOut) / 2, bhw = (bandOut - bandIn) / 2;
    const { left, right } = polylineToStrip(road.pts, mid * 2);
    const laneFree = (x: number, z: number, yaw: number, w: number, l: number) => {
      const long = Math.max(w, l), short = Math.min(w, l);
      const n = Math.max(1, Math.ceil((long - short) / (short * 0.7)) + 1);
      for (let i = 0; i < n; i++) {
        const fo = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - short);
        const [px, pz] = w >= l ? local(x, z, yaw, fo, 0) : local(x, z, yaw, 0, fo);
        for (const line of [left, right]) for (let k = 1; k < line.length; k++) {
          if (distToSegment(px, pz, line[k - 1][0], line[k - 1][1], line[k][0], line[k][1]) < bhw + short / 2) return false;
        }
      }
      return true;
    };
    return { at, road, laneFree };
  }

  /**
   * "Last line" just inside the main gate: sandbag emplacements on both flanks (verge / walkway) facing the gate,
   * barricade wings and spent crates. Both carriageways stay open (protected band between the divider scooters
   * and the kerb is never touched). Each emplacement slides inward until it fits (the layout is still moving).
   */
  gateDefence(): void {
    const F = this.gateRoadFrame();
    if (!F) return;
    const hw = F.road.width / 2;
    const tryPiece = (name: string, a: number, o: number, yawOff: number, extra: PlaceOpts = {}, dry = false) => {
      const { x, z, face } = F.at(a, o);
      const yaw = face + yawOff;
      const fp = this.footprint(name, extra.pitch, extra.roll);
      if (!fp) return null;
      const [cx, cz] = local(x, z, yaw, fp.ox, fp.oz);
      if (!F.laneFree(cx, cz, yaw, fp.w, fp.l)) return null;
      if (dry) return this.rectFree(cx, cz, yaw, fp.w, fp.l, 0.02, { laneOk: true }) ? ({ x, z, yaw } as Placed) : null;
      return this.place(name, x, z, yaw, { margin: 0.02, laneOk: true, ...extra });
    };
    const bag = { shape: 'rect' as const, surface: 'ground' as SurfaceKind, pad: -0.05, h: 0.85 };
    // arc of bags around a centre, bulges toward the gate. Bags are validated one by one against the world
    // (dry run), then the passing ones are placed together (they overlap each other on purpose).
    const arcFits = (a0: number, o0: number, rad: number, angs: number[]) =>
      angs.filter((ang) => tryPiece('sandbags', a0 - Math.cos(ang * DEG) * rad, o0 + Math.sin(ang * DEG) * rad, -ang * DEG, {}, true));
    const emplace = (o0: number, angs: number[]) => {
      for (let a0 = 9; a0 <= 22; a0 += 1.5) {
        const ok = arcFits(a0, o0, 2.3, angs);
        if (ok.length < angs.length - 1 || !ok.includes(0)) continue;
        for (const ang of ok) {
          const { x, z, face } = F.at(a0 - Math.cos(ang * DEG) * 2.3, o0 + Math.sin(ang * DEG) * 2.3);
          const p = this.place('sandbags', x, z, face - ang * DEG, { force: true, solid: { ...bag, h: ang === 0 ? 1.65 : 0.85 } });
          if (p && ang === 0) this.place('sandbags', p.x, p.z, p.yaw + 0.05, { y: 0.8, force: true });
        }
        return a0;
      }
      return null;
    };
    const aN = emplace(-(hw + 2.2), [-50, 0, 50]);
    const aS = emplace(hw + 2.0, [-50, 0, 50]);
    // barricade wings dragged across the verges, one knocked flat in a gap of the scooter rows
    if (aN !== null) {
      tryPiece('barricade', aN + 4.5, -(hw + 1.6), 0.35, { solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: 0.05 } });
      tryPiece('ammo', aN + 2.6, -(hw + 2.3), 0.5, { solid: { shape: 'circle', surface: 'wood' } });
      tryPiece('ammo', aN + 3.1, -(hw + 1.6), -0.3, { solid: { shape: 'circle', surface: 'wood' } });
    }
    if (aS !== null) {
      tryPiece('barricade', aS + 4.2, hw + 1.5, -0.4, { solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: 0.05 } });
      tryPiece('ammo', aS + 2.7, hw + 2.1, 0.2, { solid: { shape: 'circle', surface: 'wood' } });
    }
    for (const [a, o, yo] of [[8, -(hw - 0.9), 1.45], [12.5, hw - 0.8, 1.7], [15, -(hw + 1.3), 0.8]] as [number, number, number][]) {
      tryPiece('barricade', a, o, yo, { pitch: HALF_PI - 0.06, solid: { shape: 'rect', surface: 'metal', h: 0.4 } });
    }
  }

  forecourt(): void {
    const g = GATES.find((q) => q.id === 'main');
    if (!g) return;
    const f = gateFrame(g);
    const R = rng(733);
    const P = (s: number, d: number): V2 => [f.mid[0] + f.u[0] * s + f.n[0] * d, f.mid[1] + f.u[1] * s + f.n[1] * d];
    const inYaw = yawTo(f.n[0], f.n[1]);
    const acrossYaw = inYaw + HALF_PI; // barricade length across the approach
    // scissor barricades in a loose, broken line ~11 m outside the gate
    for (let s = -f.len / 2 - 2; s <= f.len / 2 + 3; s += 2.7) {
      const d = -10.5 - R() * 1.6;
      const [x, z] = P(s + (R() - 0.5) * 0.5, d);
      const fallen = R() < 0.4;
      const yaw = acrossYaw + (R() - 0.5) * (fallen ? 1.6 : 0.3);
      this.place('barricade', x, z, yaw, fallen
        ? { pitch: (R() < 0.5 ? -1 : 1) * (HALF_PI - 0.06), margin: 0.05, solid: { shape: 'rect', surface: 'metal', h: 0.4 } }
        : { margin: 0.05, solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: 0.05 } });
    }
    // a couple more knocked around by the horde, further out
    for (let i = 0; i < 4; i++) {
      const [x, z] = P((R() - 0.5) * 18, -16 - R() * 12);
      this.place('barricade', x, z, R() * Math.PI * 2, { pitch: -HALF_PI + 0.06, margin: 0.1, solid: { shape: 'rect', surface: 'metal', h: 0.4 } });
    }
    // proper Namma Metro barrier panels on the ORR verge either side of the forecourt mouth (mouth left open)
    const gt = (f.mid[0] - ORR.origin[0]) * ORR.dir[0] + (f.mid[1] - ORR.origin[1]) * ORR.dir[1];
    const vergeOff = -(ORR.width / 2 + 1.1);
    const faceRoad = yawTo(ORR.dir[1], -ORR.dir[0]); // panel front toward the carriageway (NE)
    for (const [t0, t1] of [[gt - 24, gt - 12], [gt + 14, gt + 25]]) {
      for (let t = t0; t < t1; t += 2.78) {
        const [x, z] = orrPoint(t, vergeOff + (R() - 0.5) * 0.1);
        this.place('metro', x, z, faceRoad + (R() - 0.5) * 0.05, { margin: 0.02, laneOk: true, solid: { shape: 'seg', surface: 'metal', h: 2.0 } });
      }
    }
  }

  // ------------------------------------------------------------------ entry boulevard median: angle-parked scooters
  /** Scooters angle-parked along a lane divider (`pts`). The 2026 entry road has none, so Campus passes no points. */
  medianScooters(pts: V2[]): void {
    if (pts.length < 2) return;
    const pl = polyline(pts);
    const road = ROADS.find((r) => r.id === 'entry');
    const mh = (road?.median ?? 2.4) / 2;
    const f = this.footprint('bike');
    if (!f) return;
    const a60 = 60 * DEG;
    const reach = (f.l / 2) * Math.sin(a60) + (f.w / 2) * Math.cos(a60);
    for (const side of [-1, 1]) {
      const R = rng(side > 0 ? 901 : 907);
      let s = 1.5 + R() * 3;
      while (s < pl.length - 1) {
        const n = 3 + Math.floor(R() * 7);
        for (let k = 0; k < n && s < pl.length - 0.8; k++) {
          const { p, d } = pl.at(s);
          const out: V2 = [-d[1] * side, d[0] * side];
          const fx = -out[0] * Math.sin(a60) + d[0] * Math.cos(a60) * side;
          const fz = -out[1] * Math.sin(a60) + d[1] * Math.cos(a60) * side;
          let yaw = yawTo(fx, fz) + (R() - 0.5) * 0.14;
          const off = mh + 0.08 + reach + (R() - 0.5) * 0.1;
          let x = p[0] + out[0] * off, z = p[1] + out[1] * off;
          const color = SCOOTER_PAINT[Math.floor(R() * SCOOTER_PAINT.length)];
          const fallen = k === n - 1 && R() < 0.4;
          if (fallen) {
            // toppled into the gap, falling toward +d
            x += d[0] * 0.5 + out[0] * 0.3; z += d[1] * 0.5 + out[1] * 0.3;
            const leftX = -Math.cos(yaw), leftZ = Math.sin(yaw);
            const roll = (leftX * d[0] + leftZ * d[1] > 0 ? 1 : -1) * (78 * DEG);
            yaw += (R() - 0.5) * 0.4;
            this.place('bike', x, z, yaw, { roll, color, margin: 0.0, laneOk: true, solid: { shape: 'rect', surface: 'metal', h: 0.6, pad: -0.1 } });
          } else {
            this.place('bike', x, z, yaw, { color, margin: -0.05, laneOk: true, solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: -0.2 } });
          }
          s += 1.1 + R() * 0.2;
        }
        s += R() < 0.25 ? 9 + R() * 7 : 3 + R() * 5;
      }
    }
  }

  // ------------------------------------------------------------------ cars around MRD / B-Block
  campusCars(): void {
    const near = BUILDINGS.filter((b) => b.id === 'mrd' || b.id === 'bblock');
    if (!near.length) return;
    const R = rng(1201);
    const fc = this.footprint('car');
    if (!fc) return;
    // perpendicular parking rows wherever a 4.6–10 m strip lies between a road and B-Block / MRD (≤ 11 per block)
    for (const bld of near) {
      let row = 0;
      ROADS.forEach((rd) => {
        if (rd.kind !== 'asphalt' || rd.id === 'entry') return;
        for (const side of [-1, 1]) {
          for (const smp of samplePolyline(rd.pts, 2.7, 0, 1.35)) {
            if (row >= 11) return;
            const nx = -smp.dir[1] * side, nz = smp.dir[0] * side;
            const off = rd.width / 2 + 0.35 + fc.l / 2;
            const x = smp.p[0] + nx * off, z = smp.p[1] + nz * off;
            if (distToPoly(x, z, bld.poly) > 9 || distToPoly(x + nx * (fc.l / 2 + 0.6), z + nz * (fc.l / 2 + 0.6), bld.poly) > 3.5) continue;
            if (R() < 0.18) continue; // empty bays
            const nose = R() < 0.8 ? 1 : -1; // mostly nose-in
            const yaw = yawTo(nx * nose, nz * nose) + (R() - 0.5) * (R() < 0.2 ? 0.5 : 0.08);
            if (this.place('car', x, z, yaw, { color: CAR_PAINT[Math.floor(R() * CAR_PAINT.length)], margin: 0.12, solid: { shape: 'rect', surface: 'metal' } })) row++;
          }
        }
      });
    }
    // parallel-parked / abandoned cars along the kerbs near the two blocks (never both sides at once)
    let n = 0;
    ROADS.forEach((rd, ri) => {
      if (rd.kind !== 'asphalt' || rd.id === 'entry') return;
      let prev = false;
      for (const smp of samplePolyline(rd.pts, 6.6, 0, 3.3)) {
        if (n >= 22) return;
        const dNear = Math.min(...near.map((b) => distToPoly(smp.p[0], smp.p[1], b.poly)));
        if (dNear > 30) { prev = false; continue; }
        const occupy = R() < (prev ? 0.55 : 0.22);
        prev = false;
        if (!occupy) continue;
        const sLen = this.alongRoad(ri, smp.p);
        for (const side of R() < 0.5 ? [1, -1] : [-1, 1]) {
          if (this.roadVehicles.some((v) => v.road === ri && v.side !== side && Math.abs(v.s - sLen) < 7)) continue;
          const nx = -smp.dir[1] * side, nz = smp.dir[0] * side;
          const askew = R() < 0.22;
          const off = rd.width / 2 - 0.2 - fc.w / 2 - (askew ? 0.35 : 0);
          const x = smp.p[0] + nx * off, z = smp.p[1] + nz * off;
          const heading = R() < 0.5 ? 0 : Math.PI;
          const yaw = yawTo(smp.dir[0], smp.dir[1]) + heading + (askew ? (R() - 0.5) * 0.7 : (R() - 0.5) * 0.06);
          const p = this.place('car', x, z, yaw, { color: CAR_PAINT[Math.floor(R() * CAR_PAINT.length)], margin: 0.1, solid: { shape: 'rect', surface: 'metal' } });
          if (p) { this.roadVehicles.push({ road: ri, s: sLen, side }); n++; prev = true; break; }
        }
      }
    });
  }

  private alongRoad(ri: number, p: V2): number {
    const pts = ROADS[ri].pts;
    let best = Infinity, acc = 0, at = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (l * l)));
      const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]);
      if (d < best) { best = d; at = acc + t * l; }
      acc += l;
    }
    return at;
  }

  /** Yellow PES college buses: in the GJBC east forecourt (bus drop-off) and at the bus-bay kerb. */
  collegeBuses(): void {
    const R = rng(1301);
    const fb = this.footprint('college_bus');
    if (!fb) return;
    let n = 0;
    // parked on the forecourt pavers, parallel to the colonnade (long axis N–S), nose toward the exit
    const fc = AREAS.find((a) => a.id === 'gjbc_east_forecourt');
    if (fc) {
      const xs = fc.poly.map((p) => p[0]), zs = fc.poly.map((p) => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const cz = (minZ + maxZ) / 2;
      for (let x = maxX - fb.w / 2 - 0.8; x > minX + fb.w / 2 && n < 2; x -= 0.6) {
        if (this.place('college_bus', x, cz + (R() - 0.5) * 2, Math.PI + (R() - 0.5) * 0.05, { margin: 0.25, offRoad: true, solid: { shape: 'rect', surface: 'metal' } })) { n++; x -= fb.w + 1.4; }
      }
    }
    ROADS.forEach((rd, ri) => {
      if (n >= 3 || rd.kind !== 'asphalt' || rd.id === 'entry' || rd.width < 7) return;
      if (rd.id !== undefined && rd.id !== 'bus_bay') return;
      for (const smp of samplePolyline(rd.pts, 3, 0, 6)) {
        if (n >= 3) return;
        if (fc && distToPoly(smp.p[0], smp.p[1], fc.poly) > 25) continue;
        for (const side of [-1, 1]) {
          const sLen = this.alongRoad(ri, smp.p);
          if (this.roadVehicles.some((v) => v.road === ri && Math.abs(v.s - sLen) < 14)) continue;
          const nx = -smp.dir[1] * side, nz = smp.dir[0] * side;
          const off = rd.width / 2 - 0.25 - fb.w / 2;
          const x = smp.p[0] + nx * off, z = smp.p[1] + nz * off;
          const yaw = yawTo(smp.dir[0], smp.dir[1]) + (R() - 0.5) * 0.04;
          if (this.place('college_bus', x, z, yaw, { margin: 0.1, laneOk: true, solid: { shape: 'rect', surface: 'metal' } })) {
            this.roadVehicles.push({ road: ri, s: sLen, side });
            n++;
            break;
          }
        }
      }
    });
    // one waiting at the entry road's south (walkway-side) kerb, nose toward the gate (2026 tour 0530), just west of the
    // player spawn
    const ei = ROADS.findIndex((r) => r.id === 'entry');
    const walk = AREAS.find((a) => a.id === 'entry_south_walkway');
    if (ei >= 0 && walk) {
      const rd = ROADS[ei];
      for (const smp of samplePolyline(rd.pts, 1.5, 0, 0.75)) {
        if (smp.p[0] > 118 || smp.p[0] < 108) continue;
        let nx = -smp.dir[1], nz = smp.dir[0];
        if (distToPoly(smp.p[0] + nx * 8, smp.p[1] + nz * 8, walk.poly) > distToPoly(smp.p[0] - nx * 8, smp.p[1] - nz * 8, walk.poly)) { nx = -nx; nz = -nz; }
        const off = rd.width / 2 - 0.3 - fb.w / 2;
        const yaw = yawTo(-smp.dir[0], -smp.dir[1]) + (R() - 0.5) * 0.03; // the polyline runs from the gate westward
        if (this.place('college_bus', smp.p[0] + nx * off, smp.p[1] + nz * off, yaw, { margin: 0.1, laneOk: true, solid: { shape: 'rect', surface: 'metal' } })) {
          this.roadVehicles.push({ road: ei, s: this.alongRoad(ei, smp.p), side: 1 });
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ Outer Ring Road
  orr(): void {
    // The Ring Road is animated by TrafficSystem. Keep only the physical metro worksite here;
    // parked/crashed vehicles made the road look permanently blocked.
    this.metroPit();
    return;
    const R = rng(515);
    const dirYaw = yawTo(ORR.dir[0], ORR.dir[1]);
    const halfMain = (ORR.width - ORR.median) / 2;
    const lanes = [0.5, 1.5, 2.5].map((k) => ORR.median / 2 + (halfMain / 3) * k);
    const at = (t: number, off: number) => orrPoint(t, off);
    const heading = (off: number) => dirYaw + (off < 0 ? Math.PI : 0); // drive on the left: campus side heads WNW
    const car = (t: number, off: number, yaw: number, extra: PlaceOpts = {}) => {
      const [x, z] = at(t, off);
      return this.place('car', x, z, yaw, { color: CAR_PAINT[Math.floor(R() * CAR_PAINT.length)], margin: 0.25, laneOk: true, solid: { shape: 'rect', surface: 'metal' }, ...extra });
    };
    const auto = (t: number, off: number, yaw: number, extra: PlaceOpts = {}) => {
      const [x, z] = at(t, off);
      return this.place('auto', x, z, yaw, { margin: 0.25, laneOk: true, solid: { shape: 'rect', surface: 'metal' }, ...extra });
    };

    // --- Namma Metro works: a barricaded pit around the pier nearest the main gate (first, so it gets that pier)
    this.metroPit();

    // --- set piece: BMTC bus slewed across the campus-side carriageway, with its victims
    const busOff = -(ORR.median / 2 + halfMain * 0.55);
    for (const t of [88, 84, 92, 80, 96, 76, 100, 72, 104, 108]) {
      const yaw = heading(-1) + 0.72;
      const [x, z] = at(t, busOff);
      const bus = this.place('bus', x, z, yaw, { margin: 0.3, laneOk: true, solid: { shape: 'rect', surface: 'metal' } });
      if (!bus) continue;
      // car T-boned into its flank, another spun into its tail, an auto on its side by the nose
      const side = local(x, z, yaw, -(bus!.w / 2 + 2.0), 1.6);
      const cyaw = yaw + HALF_PI + 0.25;
      this.place('car', side[0], side[1], cyaw, { color: CAR_PAINT[1], margin: 0.05, laneOk: true, force: false, solid: { shape: 'rect', surface: 'metal' } });
      const tail = local(x, z, yaw, 0.9, -(bus!.l / 2 + 2.3));
      this.place('car', tail[0], tail[1], yaw + 0.5, { color: CAR_PAINT[2], margin: 0.05, laneOk: true, solid: { shape: 'rect', surface: 'metal' } });
      for (const [lx, lz, yo] of [[2.8, bus!.l / 2 + 1.2, -1.1], [-3.2, bus!.l / 2 - 1.0, 1.9], [bus!.w / 2 + 1.6, -1.5, 0.4], [-(bus!.w / 2 + 1.6), -3.5, 2.6]] as [number, number, number][]) {
        const nose = local(x, z, yaw, lx, lz);
        if (this.place('auto', nose[0], nose[1], yaw + yo, { roll: HALF_PI, margin: 0.05, laneOk: true, solid: { shape: 'rect', surface: 'metal' } })) break;
      }
      break;
    }
    // a second BMTC stalled on the far carriageway, doors-open look (just parked askew)
    for (const t of [150, 158, 142, 166, 134]) {
      const [x, z] = at(t, lanes[2] + 0.4);
      if (this.place('bus', x, z, heading(1) - 0.12, { margin: 0.3, laneOk: true, solid: { shape: 'rect', surface: 'metal' } })) break;
    }

    // --- scattered abandoned / crashed traffic on both carriageways
    // pile-ups: a knot of cars nose-to-tail at odd angles on each carriageway
    for (const [t0, side] of [[58, -1], [142, 1], [18, 1]] as [number, number][]) {
      for (let k = 0; k < 4; k++) {
        const off = side * (lanes[k % 3] + (R() - 0.5) * 0.8);
        const yaw = heading(off) + (R() - 0.5) * 2.2;
        if (R() < 0.75) car(t0 + k * 3.2 + R(), off, yaw, R() < 0.12 ? { roll: Math.PI } : {});
        else auto(t0 + k * 3.2 + R(), off, yaw, R() < 0.4 ? { roll: HALF_PI } : {});
      }
    }
    for (let t = -70; t < 225; t += t > 25 && t < 190 ? 5 + R() * 6 : 10 + R() * 10) {
      if (R() < 0.2) continue;
      const side = R() < 0.55 ? -1 : 1;
      const off = side * (lanes[Math.floor(R() * 3)] + (R() - 0.5) * 1.0);
      const crash = R();
      let yaw = heading(off) + (crash < 0.55 ? (R() - 0.5) * 0.35 : (R() - 0.5) * 2.8);
      if (R() < 0.08) yaw += Math.PI;
      if (R() < 0.72) {
        const flip = R() < 0.07;
        car(t, off, yaw, flip ? { roll: Math.PI } : {});
        // pile-up partner
        if (crash > 0.85) car(t + 5.2, off + (R() - 0.5) * 2, yaw + (R() - 0.5) * 1.2);
      } else {
        const tip = R() < 0.25;
        auto(t, off, yaw, tip ? { roll: (R() < 0.5 ? -1 : 1) * HALF_PI } : {});
      }
    }

    // --- service roads: autos and cars left at the kerb
    const sKerb = ORR.serviceWidth / 2 - 0.25;
    for (let t = -40; t < 220; t += 10 + R() * 12) {
      if (R() < 0.35) continue;
      const far = R() < 0.35;
      const base = far ? -ORR.serviceOffset : ORR.serviceOffset; // campus side is negative
      const kerbSide = far ? 1 : -1; // outer kerb
      const isAuto = R() < 0.6;
      const fw = this.footprint(isAuto ? 'auto' : 'car')!;
      const off = base + kerbSide * (sKerb - fw.w / 2);
      const yaw = heading(far ? 1 : -1) + (R() - 0.5) * 0.25;
      if (isAuto) auto(t, off, yaw, { noClear: false, margin: 0.15 });
      else car(t, off, yaw, { noClear: false, margin: 0.15 });
    }

  }

  private metroPit(): void {
    const main = GATES.find((g) => g.id === 'main');
    const gm: V2 = main ? [(main.a[0] + main.b[0]) / 2, (main.a[1] + main.b[1]) / 2] : orrPoint(100, -40);
    const piers = this.col.cyls.filter((c) => c.tag === 'pier').map((c) => ({ x: c.x, z: c.z, d: Math.hypot(c.x - gm[0], c.z - gm[1]) })).sort((a, b) => a.d - b.d);
    const dirYaw = yawTo(ORR.dir[0], ORR.dir[1]);
    const halfL = 6.6, halfW = 4.3;
    for (const pr of piers.slice(0, 6)) {
      // pit sits beside the pier, fence rectangle centred between
      const [cx, cz] = local(pr.x, pr.z, dirYaw, 0, 1.5);
      const ok = rectPoly(cx, cz, dirYaw, halfW * 2 + 1, halfL * 2 + 1).every(([x, z]) => this.free(x, z, 0.4, { laneOk: true }))
        && this.spawnPts.every((p) => Math.hypot(p[0] - cx, p[1] - cz) > halfL + 4);
      if (!ok) continue;
      // fence: metro barrier panels, feet inside
      const corners = rectPoly(cx, cz, dirYaw, halfW * 2, halfL * 2);
      for (let e = 0; e < 4; e++) {
        const a = corners[e], b = corners[(e + 1) % 4];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.round(len / 2.72));
        const ex = (b[0] - a[0]) / len, ez = (b[1] - a[1]) / len;
        // outward normal of this edge
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        let nx = -ez, nz = ex;
        if ((mx + nx - cx) ** 2 + (mz + nz - cz) ** 2 < (mx - cx) ** 2 + (mz - cz) ** 2) { nx = -nx; nz = -nz; }
        const yaw = yawTo(nx, nz); // panel +Z faces out
        for (let k = 0; k < n; k++) {
          if (e === 1 && k === 1) continue; // gap for the work crew... blocked below by a knocked panel
          const f = (k + 0.5) / n;
          this.place('metro', a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, yaw, { force: true });
        }
        this.col.addSegment(a, b, 0.45, 2.0, 'metal', 'prop');
      }
      // the missing panel lies flat just outside
      {
        const a = corners[1], b = corners[2];
        const ex = b[0] - a[0], ez = b[1] - a[1];
        const len = Math.hypot(ex, ez);
        const n = Math.max(1, Math.round(len / 2.72));
        const f = 1.5 / n;
        const [mx, mz] = [a[0] + ex * f, a[1] + ez * f];
        const out = yawTo(mx - cx, mz - cz);
        const [px, pz] = local(mx, mz, out, 0.3, 1.3);
        this.place('metro', px, pz, out + 0.3, { pitch: HALF_PI - 0.05, force: true });
      }
      // the fenced interior is solid for navigation (no sealed walkable pocket), low enough to shoot over
      this.col.addPolygon(rectPoly(cx, cz, dirYaw, halfW * 2 - 0.3, halfL * 2 - 0.3), 0.45, 'ground', 'prop');
      // pit: dark excavated soil, spoil heap, rebar cage
      const b = new VBuilder();
      const m = new THREE.Matrix4().compose(new THREE.Vector3(cx, 0, cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dirYaw), new THREE.Vector3(1, 1, 1));
      b.transform(m);
      b.set(0x3a2a1f, 0.95, 0);
      b.patch(0, 2.2, halfW * 2 - 0.8, 6.5, 0, 0.085);
      b.set(0x1c140f, 1, 0);
      b.patch(0, 2.6, halfW * 2 - 2.4, 4.2, 0, 0.09);
      b.set(0x7a5a3e, 1, 0);
      b.mound(-1.6, -3.4, 1.9, 1.3, 77);
      b.mound(1.9, -4.3, 1.2, 0.8, 78);
      b.set(0x6b3f2a, 0.6, 0.7);
      for (let i = 0; i < 6; i++) b.box(-1.2 + i * 0.45, 0.9, 5.2, 0.03, 1.8, 0.03);
      for (let j = 0; j < 3; j++) b.box(-0.08, 0.35 + j * 0.6, 5.2, 2.4, 0.03, 0.03);
      b.set(0xe0c070, 0.9, 0);
      b.box(2.4, 0.25, 0.5, 1.2, 0.5, 0.8); // cement bags
      b.box(2.45, 0.62, 0.45, 1.0, 0.24, 0.7);
      b.transform(null);
      this.addStatic(b.geometry());
      return;
    }
  }

  // ------------------------------------------------------------------ food court
  foodCourt(): void {
    const apron = AREAS.find((a) => a.kind === 'concrete' && pointInPoly(127, -16, a.poly));
    const R = rng(1401);
    let minX = 121.5, minZ = -30, maxX = 133.4, maxZ = -3;
    if (apron) { minX = Math.min(...apron.poly.map((p) => p[0])); maxX = Math.max(...apron.poly.map((p) => p[0])); minZ = Math.min(...apron.poly.map((p) => p[1])); maxZ = Math.max(...apron.poly.map((p) => p[1])); }
    // tables between the canopy posts
    for (let tz = minZ + 4.5; tz < maxZ - 1.5; tz += 6) {
      for (let tx = minX + 3.5; tx < maxX - 1.5; tx += 5) {
        const knocked = R() < 0.25;
        for (let tries = 0; tries < 4; tries++) {
          const jx = (R() - 0.5) * (knocked ? 1.2 : 0.4), jz = (R() - 0.5) * (knocked ? 1.2 : 0.4);
          const yaw = knocked ? R() * Math.PI * 2 : (R() - 0.5) * 0.35;
          if (this.place('table', tx + jx, tz + jz, yaw, { margin: 0.05, solid: { shape: 'circle', surface: 'metal', h: 0.8, pad: -0.2 } })) break;
        }
      }
    }
    // loose chairs knocked over around the food court and the food point
    for (let i = 0, n = 0; i < 40 && n < 9; i++) {
      const x = minX - 2 + R() * (maxX - minX + 12), z = minZ - 2 + R() * (maxZ - minZ + 4);
      const lie = R();
      const o: PlaceOpts = lie < 0.4 ? { pitch: -HALF_PI - 0.25 } : lie < 0.8 ? { roll: (R() < 0.5 ? -1 : 1) * HALF_PI } : {};
      if (this.place('chair', x, z, R() * Math.PI * 2, { ...o, margin: 0.05, offRoad: true })) n++;
    }
    // water coolers against the food point's west wall
    const thindies = BUILDINGS.find((b) => b.id === 'thindies');
    if (thindies) {
      const wx = Math.min(...thindies.poly.map((p) => p[0]));
      for (const z of [-17.8, -12.2]) this.againstWall('cooler', wx - 0.2, z, -HALF_PI, [-1, 0], { shape: 'circle', surface: 'metal' });
      // bikes parked in front of the food point (south face)
      const sz = Math.min(...thindies.poly.map((p) => p[1]));
      for (let i = 0; i < 6; i++) {
        const x = wx + 4 + i * 1.05 + (i > 2 ? 1.2 : 0);
        this.place('bike', x, sz - 1.25, Math.PI + (R() - 0.5) * 0.2, { color: SCOOTER_PAINT[Math.floor(R() * SCOOTER_PAINT.length)], margin: -0.05, solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: -0.2 } });
      }
    }
    // bins at the apron corners
    for (const [x, z] of [[minX + 0.5, minZ + 1.2], [minX + 0.5, maxZ - 1.0], [maxX - 0.6, maxZ - 1.2]] as V2[]) this.place('bin', x, z, R() * 6, { margin: 0.05, solid: { shape: 'circle', surface: 'metal' } });
  }

  /** Step from (x,z) away from a wall along `away` until the prop fits. */
  private againstWall(name: string, x: number, z: number, yaw: number, away: V2, solid: PlaceOpts['solid'], steps = 16): Placed | null {
    for (let k = 0; k < steps; k++) {
      const p = this.place(name, x + away[0] * k * 0.12, z + away[1] * k * 0.12, yaw, { margin: 0.03, solid });
      if (p) return p;
    }
    return null;
  }

  // ------------------------------------------------------------------ GJB courtyard (Quad)
  courtyard(): void {
    // The Quad is on the GJBC 1st floor (GJB_L1 podium, reference/GJB_NOTES.md): its dressing is lifted to L1 and
    // forced (the podium prism fills the ground-floor footprint). Decor only for now — TODO: give these collision at
    // L1 once multi-level movement lands (StaticCollision circles have no base yet).
    const R = rng(1501);
    const y = QUAD.floorY;
    const minX = QUAD.minX - 4, maxX = QUAD.maxX + 4, minZ = QUAD.minZ, maxZ = QUAD.maxZ;
    const cx = (minX + maxX) / 2, w = maxX - minX;
    const deco = { y, force: true };
    // two rows of benches facing the middle of the Quad (kite-able lanes left between them and the arcades)
    for (const [x, yaw] of [[cx - w * 0.2, HALF_PI], [cx + w * 0.2, -HALF_PI]] as V2[]) {
      for (let z = minZ + 9; z < maxZ - 6; z += 9) {
        this.place('bench', x, z, yaw + (R() - 0.5) * 0.05, deco);
        if (R() < 0.45) {
          const [bx, bz] = local(x, z, yaw, (R() < 0.5 ? -1 : 1) * 1.35, 0.1);
          this.place('bin', bx, bz, R() * 6, deco);
        }
      }
    }
    // water coolers against the arcade back walls, a bin rolling on the granite
    for (const [x, z, yaw] of [[minX + 0.45, (minZ + maxZ) / 2 - 3, HALF_PI], [maxX - 0.45, (minZ + maxZ) / 2 + 9, -HALF_PI], [maxX - 0.45, minZ + 24, -HALF_PI]] as [number, number, number][]) {
      this.place('cooler', x, z, yaw, deco);
    }
    this.place('bin', cx + 3.5, maxZ - 12, 1.1, { ...deco, roll: HALF_PI });
  }

  // ------------------------------------------------------------------ lawns: benches + bins
  lawns(): void {
    AREAS.forEach((a, ai) => {
      if (a.kind !== 'lawn') return;
      const R = rng(300 + ai * 7);
      const ring = [...a.poly, a.poly[0]];
      let placed = 0;
      for (const smp of samplePolyline(ring, 12.5, 0, 4 + R() * 4)) {
        if (placed >= 9) break;
        if (R() < 0.35) continue;
        let nx = -smp.dir[1], nz = smp.dir[0];
        if (!pointInPoly(smp.p[0] + nx * 1.5, smp.p[1] + nz * 1.5, a.poly)) { nx = -nx; nz = -nz; }
        if (!pointInPoly(smp.p[0] + nx * 1.5, smp.p[1] + nz * 1.5, a.poly)) continue;
        const x = smp.p[0] + nx * 1.05, z = smp.p[1] + nz * 1.05;
        const yaw = yawTo(-nx, -nz) + (R() - 0.5) * 0.06; // sit facing the path
        const p = this.place('bench', x, z, yaw, { margin: 0.25, offRoad: true, solid: { shape: 'rect', surface: 'wood' } });
        if (!p) continue;
        placed++;
        if (R() < 0.55) {
          const [bx, bz] = local(x, z, yaw, (R() < 0.5 ? -1 : 1) * 1.4, 0.05);
          const tipped = R() < 0.15;
          this.place('bin', bx, bz, R() * 6, tipped ? { roll: HALF_PI, margin: 0.05, offRoad: true } : { margin: 0.05, offRoad: true, solid: { shape: 'circle', surface: 'metal' } });
        }
      }
    });
  }

  // ------------------------------------------------------------------ building entrances: bins + notice boards
  entrances(): void {
    const R = rng(1601);
    for (const b of BUILDINGS) {
      if (!b.sign || (b.base ?? 0) > 0) continue;
      const poly = b.poly;
      const a = poly[b.sign.edge % poly.length], c = poly[(b.sign.edge + 1) % poly.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 4) continue;
      const ux = dx / len, uz = dz / len;
      let nx = -uz, nz = ux;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      if (pointInPoly(mx + nx * 0.5, mz + nz * 0.5, poly)) { nx = -nx; nz = -nz; }
      for (const sgn of [-1, 1]) {
        const along = sgn * Math.min(len * 0.3, 3.2);
        this.place('bin', mx + ux * along + nx * 1.4, mz + uz * along + nz * 1.4, R() * 6, { margin: 0.05, offRoad: true, solid: { shape: 'circle', surface: 'metal' } });
      }
      if (len > 12) {
        const along = Math.min(len * 0.35, 6.5);
        this.noticeBoard(mx + ux * along + nx * 1.1, mz + uz * along + nz * 1.1, yawTo(nx, nz));
      }
    }
  }

  private noticeBoard(x: number, z: number, yaw: number): boolean {
    const w = 1.5, h = 1.05;
    // occupancy check (thin footprint)
    if (!this.rectFree(x, z, yaw, w + 0.2, 0.3, 0.05, { offRoad: true })) return false;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    const posts = new VBuilder().transform(m);
    posts.set(0x3a3d42, 0.5, 0.5);
    posts.box(-w / 2 - 0.05, 1.0, 0, 0.07, 2.0, 0.07);
    posts.box(w / 2 + 0.05, 1.0, 0, 0.07, 2.0, 0.07);
    posts.set(0x5a3b22, 0.7, 0);
    posts.box(0, 2.08, -0.02, w + 0.3, 0.06, 0.28); // little rain hood
    posts.box(0, 0.93 + h / 2, -0.035, w + 0.08, h + 0.08, 0.05); // frame/back
    this.addStatic(posts.geometry());
    this.boards.transform(m).set(0xffffff, 0.85, 0);
    this.boards.box(0, 0.93 + h / 2, 0.0, w, h, 0.02, 0, [0, 0, 1, 1]);
    this.boards.transform(null);
    this.col.addSegment(local(x, z, yaw, -w / 2, 0), local(x, z, yaw, w / 2, 0), 0.25, 2.0, 'wood', 'prop');
    return true;
  }

  // ------------------------------------------------------------------ bikes near the bike shed and hostels
  bikeClusters(): void {
    const R = rng(1701);
    const paint = () => SCOOTER_PAINT[Math.floor(R() * SCOOTER_PAINT.length)];
    const bike = (x: number, z: number, yaw: number) =>
      this.place('bike', x, z, yaw + (R() - 0.5) * 0.16, { color: paint(), margin: -0.05, offRoad: true, solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: -0.2 } });
    // 2-wheeler parking along the east lawn, both levels (reference/GJB_NOTES.md §4; slots from gjb/parking.ts).
    // Ground floor: normal prop collision; upper deck: decor at the deck height (its row collision is registered by the parking).
    for (const sl of parkingSlots()) {
      if (sl.y > 0) this.place('bike', sl.x, sl.z, sl.yaw + (R() - 0.5) * 0.12, { color: paint(), y: sl.y, force: true });
      else this.place('bike', sl.x, sl.z, sl.yaw + (R() - 0.5) * 0.12, { color: paint(), margin: -0.05, laneOk: true, solid: { shape: 'seg', surface: 'metal', h: 1.1, pad: -0.2 } });
    }
    // hostels: rows nosed against the walls facing a road
    for (const b of BUILDINGS.filter((q) => q.style === 'hostel')) {
      const ring = [...b.poly, b.poly[0]];
      let rows = 0;
      let run = 0;
      for (const smp of samplePolyline(ring, 1.05, 0, 0.5)) {
        if (rows >= 4) break;
        let nx = -smp.dir[1], nz = smp.dir[0];
        if (pointInPoly(smp.p[0] + nx * 0.4, smp.p[1] + nz * 0.4, b.poly)) { nx = -nx; nz = -nz; }
        const x = smp.p[0] + nx * 1.3, z = smp.p[1] + nz * 1.3;
        const nearRoad = ROADS.some((rd) => rd.pts.some((_, i) => i > 0 && distToSegment(x, z, rd.pts[i - 1][0], rd.pts[i - 1][1], rd.pts[i][0], rd.pts[i][1]) < rd.width / 2 + 14));
        if (!nearRoad) { if (run) { rows++; run = 0; } continue; }
        if (run === 0 && R() < 0.85) continue;
        if (bike(x, z, yawTo(-nx, -nz))) run++;
        else if (run) { rows++; run = 0; }
        if (run >= 6 + Math.floor(R() * 5)) { rows++; run = 0; }
      }
    }
  }
}

function gateFrame(g: GateDef): { mid: V2; u: V2; n: V2; len: number } {
  const dx = g.b[0] - g.a[0], dz = g.b[1] - g.a[1];
  const len = Math.hypot(dx, dz) || 1;
  const u: V2 = [dx / len, dz / len];
  const mid: V2 = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
  let n: V2 = [-u[1], u[0]];
  if ((PLAYER_SPAWN[0] - mid[0]) * n[0] + (PLAYER_SPAWN[1] - mid[1]) * n[1] < 0) n = [-n[0], -n[1]];
  return { mid, u, n, len };
}

// ---------------------------------------------------------------------------------------------
const P = (f: string) => `${MODEL_DIR}props/${f}.glb`;
const W = (f: string) => `${MODEL_DIR}weapons/${f}.glb`;
/** Prop types: name → [GLB url, load options]. Textured GLBs come from tools/props (see docs/ARCHITECTURE.md §Props). */
const PROP_DEFS: Record<string, [string, LoadOpts]> = {
  globe: [P('pes_globe'), {}],
  bike: [P('bike'), { tint: true, shadow: 1, lod: P('bike_lod') }],
  motorbike: [P('motorbike'), { tint: true, shadow: 1, lod: P('motorbike_lod') }],
  car: [P('car_hatchback'), { tint: true, lod: P('car_hatchback_lod') }],
  car_sedan: [P('car_sedan'), { tint: true, lod: P('car_sedan_lod') }],
  auto: [P('auto_rickshaw'), { lod: P('auto_rickshaw_lod') }],
  bus: [P('bmtc_bus'), { lod: P('bmtc_bus_lod') }],
  college_bus: [P('college_bus'), { lod: P('college_bus_lod') }],
  bench: [P('bench'), {}],
  table: [P('cafe_table_set'), {}],
  chair: [P('plastic_chair'), { shadow: 1 }],
  barricade: [P('folding_barricade'), { lod: P('folding_barricade_lod') }],
  metro: [P('metro_barrier'), {}],
  bin: [P('trash_bin'), { shadow: 1 }],
  cooler: [P('water_cooler'), { shadow: 1 }],
  ammo: [P('ammo_crate'), { shadow: 1 }],
  medkit: [P('medkit'), { shadow: 0 }],
  sandbags: [P('sandbags'), {}],
  // step-stack bags: the same model, own instancer with shorter shadow and draw distances (there is no `_lod`)
  stackbags: [P('sandbags'), {}],
  w_shotgun: [W('shotgun'), {}],
  w_smg: [W('smg'), {}],
  w_rifle: [W('rifle'), {}],
};

let sharedFlat: THREE.MeshStandardMaterial | null = null;
const protoCache = new Map<string, Promise<Proto | null>>();
function getProto(assets: Assets, name: string): Promise<Proto | null> {
  let p = protoCache.get(name);
  if (!p) {
    const def = PROP_DEFS[name];
    sharedFlat ??= makeFlatMaterial();
    p = def ? loadProto(assets, def[0], name, sharedFlat, def[1]) : Promise.resolve(null);
    protoCache.set(name, p);
  }
  return p;
}

/**
 * Public API for placing campus props outside Props.ts (e.g. the GJB two-wheeler parking). Returns an empty
 * InstancedProp with the same model, materials, LOD bands and shadow rules as the campus dressing; add instances, then
 * build() and add it to the scene. Collision is up to the caller (footprint: `ip.userData.box`, local metres,
 * origin at the base centre, facing +Z).
 *
 *   const ip = await createPropInstancer(assets, 'bike', quality);        // 'bike' = scooter, 'motorbike', 'car', ...
 *   ip?.addInstance(new THREE.Matrix4().compose(pos, quat, ONE), new THREE.Color(SCOOTER_PAINT[k]));
 *   ip?.build(); group.add(ip);
 */
export async function createPropInstancer(assets: Assets, name: string, quality: QualityProfile, o: { shadowDist?: number; drawDist?: number; lodDist?: number } = {}): Promise<InstancedProp | null> {
  const proto = await getProto(assets, name);
  if (!proto) return null;
  const [, sd, dd] = CHUNK[name] ?? CHUNK_DEFAULT;
  const shadowsOn = quality.shadowMapSize > 0, hiShadow = quality.shadowMapSize >= 4096;
  const casts = shadowsOn && (proto.shadow === 2 || (proto.shadow === 1 && hiShadow));
  const levels = lodLevels(proto, casts ? o.shadowDist ?? sd : 0, o.drawDist ?? dd, o.lodDist ?? LOD_DIST[name] ?? Infinity);
  const ip = new InstancedProp(`prop:${name}`, levels, proto.box, proto.parts.some((p) => p.tinted));
  ip.userData.box = proto.box.clone();
  return ip;
}

/**
 * Every prop model in a row (front row: full model, back row: its `_lod`), for props-viewer.html?showroom=1.
 * Tinted models get a paint colour so the paint mask can be checked.
 */
export async function buildShowroom(assets: Assets): Promise<{ group: THREE.Group; items: { name: string; x: number; tris: number; lodTris: number }[] }> {
  const names = Object.keys(PROP_DEFS).filter((n) => !n.startsWith('w_'));
  const protos = await Promise.all(names.map((n) => getProto(assets, n)));
  const group = new THREE.Group();
  group.name = 'showroom';
  const items: { name: string; x: number; tris: number; lodTris: number }[] = [];
  const tris = (parts: Part[]) => parts.reduce((a, q) => a + (q.geo.index ? q.geo.index.count : q.geo.attributes.position.count) / 3, 0);
  const paint = [0xa3161a, 0x1f4aa0, 0xe9e9e6, 0x5d6166];
  let x = 0;
  protos.forEach((p, i) => {
    if (!p) return;
    const w = p.box.max.x - p.box.min.x;
    x += w / 2;
    const put = (parts: Part[], z: number) => {
      for (const part of parts) {
        const m = new THREE.InstancedMesh(part.geo, part.mat, 1);
        m.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 0, z));
        if (part.tinted) m.setColorAt(0, new THREE.Color(paint[i % paint.length]));
        m.castShadow = m.receiveShadow = true;
        m.name = `showroom:${p.name}:${part.name}`;
        group.add(m);
      }
    };
    put(p.parts, 0);
    if (p.lodParts) put(p.lodParts, -Math.max(4, (p.box.max.z - p.box.min.z) + 2));
    items.push({ name: p.name, x: +x.toFixed(2), tris: tris(p.parts), lodTris: p.lodParts ? tris(p.lodParts) : 0 });
    x += w / 2 + 1.2;
  });
  return { group, items };
}

export async function buildProps(assets: Assets, collision: StaticCollision, opts: { quality: QualityProfile; medianPts: V2[] }): Promise<PropsBuild> {
  const t0 = performance.now();
  const names = Object.keys(PROP_DEFS);
  const loaded = await Promise.all(names.map((n) => getProto(assets, n)));
  const protos = new Map<string, Proto>();
  loaded.forEach((p, i) => { if (p) protos.set(names[i], p); });
  const flatMat = sharedFlat ?? makeFlatMaterial();

  const d = new Dresser(protos, collision, flatMat, opts.quality);
  // order matters: fixed anchors first, then set pieces, then scatter (each pass sees the previous ones' collision)
  d.globe();
  d.stations();
  d.stepStacks();
  d.gateDefence();
  d.forecourt();
  d.orr();
  d.medianScooters(opts.medianPts);
  d.foodCourt();
  d.courtyard();
  d.entrances();
  d.lawns();
  d.bikeClusters();
  d.finish();
  const st = d.group.userData.stats as { meshes: number; instances: number; rejected: number; counts: Record<string, number> };
  console.log(`[props] ${st.instances} instances in ${st.meshes} meshes, ${d.anchors.size} stations, ${st.rejected} spots rejected, ${(performance.now() - t0).toFixed(0)} ms`, st.counts);
  return { group: d.group, stationAnchors: d.anchors };
}
