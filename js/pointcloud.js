// Point cloud fusion, meshing and synthetic data. No three.js dependency so it
// can be unit-tested in Node.

const OFF = 65536; // 17 bits per axis -> +/-65536 voxels (655 m at 1 cm)
const SPAN = 131072;

export function voxelKey(ix, iy, iz) {
  return ((ix + OFF) * SPAN + (iy + OFF)) * SPAN + (iz + OFF);
}

// Fuses noisy depth samples into one averaged point per voxel.
export class VoxelAccumulator {
  constructor(voxelSize = 0.02, capacity = 1_500_000) {
    this.voxelSize = voxelSize;
    this.capacity = capacity;
    this.index = new Map();
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Uint8Array(capacity * 3);
    this.sums = new Float32Array(capacity * 6); // xyz rgb running sums
    this.hits = new Uint16Array(capacity);
    this.count = 0;
  }

  get full() { return this.count >= this.capacity; }

  add(x, y, z, r, g, b) {
    const s = this.voxelSize;
    const key = voxelKey(Math.floor(x / s), Math.floor(y / s), Math.floor(z / s));
    let i = this.index.get(key);
    if (i === undefined) {
      if (this.count >= this.capacity) return false;
      i = this.count++;
      this.index.set(key, i);
    } else if (this.hits[i] >= 60000) {
      return true;
    }
    const h = ++this.hits[i];
    const o = i * 6;
    const sm = this.sums;
    sm[o] += x; sm[o + 1] += y; sm[o + 2] += z;
    sm[o + 3] += r; sm[o + 4] += g; sm[o + 5] += b;
    const p = i * 3;
    this.positions[p] = sm[o] / h;
    this.positions[p + 1] = sm[o + 1] / h;
    this.positions[p + 2] = sm[o + 2] / h;
    this.colors[p] = sm[o + 3] / h;
    this.colors[p + 1] = sm[o + 4] / h;
    this.colors[p + 2] = sm[o + 5] / h;
    return true;
  }

  reset() {
    this.index.clear();
    this.sums.fill(0);
    this.hits.fill(0);
    this.count = 0;
  }

  // Compact copy, dropping voxels seen fewer than minHits times (removes most
  // single-frame depth noise / flying pixels).
  export(minHits = 1) {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.hits[i] >= minHits) n++;
    if (n < 50) minHits = 1, n = this.count; // tiny scans: keep everything
    const positions = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 3);
    let k = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.hits[i] < minHits) continue;
      positions.set(this.positions.subarray(i * 3, i * 3 + 3), k * 3);
      colors.set(this.colors.subarray(i * 3, i * 3 + 3), k * 3);
      k++;
    }
    return { positions, colors, count: n, voxelSize: this.voxelSize };
  }
}

// Unprojects a CPU depth map into world space.
//   depthAt(u, v) -> meters along the view's -Z axis (u, v normalized, top-left origin)
//   invProj / worldFromView: column-major 4x4 (Float32Array / number[16])
//   colorAt(u, v, out) -> fills out[0..2] with 0-255 (optional)
export function unprojectDepth({ width, height, depthAt, invProj, worldFromView, colorAt, minDepth = 0.15, maxDepth = 5, targetSamples = 20000 }, emit) {
  const stride = Math.max(1, Math.round(Math.sqrt((width * height) / targetSamples)));
  const P = invProj, M = worldFromView;
  const rgb = [200, 200, 200];
  let emitted = 0;
  for (let py = stride / 2; py < height; py += stride) {
    const v = py / height;
    for (let px = stride / 2; px < width; px += stride) {
      const u = px / width;
      const d = depthAt(u, v);
      if (!(d > minDepth && d < maxDepth)) continue;
      // NDC on the near plane -> view space ray
      const nx = u * 2 - 1, ny = 1 - v * 2;
      const rx = P[0] * nx + P[4] * ny - P[8] + P[12];
      const ry = P[1] * nx + P[5] * ny - P[9] + P[13];
      const rz = P[2] * nx + P[6] * ny - P[10] + P[14];
      const rw = P[3] * nx + P[7] * ny - P[11] + P[15];
      const vz = rz / rw;
      if (vz >= 0) continue;
      const t = d / -vz;
      const x = (rx / rw) * t, y = (ry / rw) * t, z = -d;
      const wx = M[0] * x + M[4] * y + M[8] * z + M[12];
      const wy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const wz = M[2] * x + M[6] * y + M[10] * z + M[14];
      if (colorAt) colorAt(u, v, rgb);
      emit(wx, wy, wz, rgb[0], rgb[1], rgb[2]);
      emitted++;
    }
  }
  return emitted;
}

// Blocky surface mesh: one quad for every voxel face that borders empty space.
// Returns indexed geometry with per-vertex colors (0-1 floats).
export function buildVoxelMesh(positions, colors, count, voxelSize, maxFaces = 3_000_000) {
  const s = voxelSize;
  const occ = new Map();
  for (let i = 0; i < count; i++) {
    const k = voxelKey(Math.floor(positions[i * 3] / s), Math.floor(positions[i * 3 + 1] / s), Math.floor(positions[i * 3 + 2] / s));
    if (!occ.has(k)) occ.set(k, i);
  }
  // [dx,dy,dz, then 4 corner offsets in CCW order seen from outside]
  const faces = [
    [1, 0, 0, [1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    [-1, 0, 0, [0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
    [0, 1, 0, [0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
    [0, -1, 0, [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [0, 0, 1, [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [0, 0, -1, [1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  ];
  const pos = [], col = [], nor = [], idx = [], src = [];
  let v = 0;
  for (const [key, i] of occ) {
    const iz = (key % SPAN) - OFF;
    const iy = (Math.floor(key / SPAN) % SPAN) - OFF;
    const ix = Math.floor(key / (SPAN * SPAN)) - OFF;
    const r = colors[i * 3] / 255, g = colors[i * 3 + 1] / 255, b = colors[i * 3 + 2] / 255;
    for (const [dx, dy, dz, ...corners] of faces) {
      if (occ.has(voxelKey(ix + dx, iy + dy, iz + dz))) continue;
      for (const c of corners) {
        pos.push((ix + c[0]) * s, (iy + c[1]) * s, (iz + c[2]) * s);
        col.push(r, g, b);
        nor.push(dx, dy, dz);
        src.push(i);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
      if (idx.length / 6 >= maxFaces) break;
    }
    if (idx.length / 6 >= maxFaces) break;
  }
  return {
    positions: new Float32Array(pos),
    colors: new Float32Array(col),
    normals: new Float32Array(nor),
    index: v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
    source: new Uint32Array(src), // per-vertex index of the point it came from
  };
}

// Re-fuses a cloud at the finest voxel size (>= minSize) that keeps it under
// `budget` voxels. Used to keep AR / USDZ models light enough for phones.
export function downsampleToBudget(positions, colors, count, minSize, budget) {
  for (let size = minSize; ; size *= 1.25) {
    const acc = new VoxelAccumulator(size, budget);
    let i = 0;
    for (; i < count; i++) {
      const p = i * 3;
      if (!acc.add(positions[p], positions[p + 1], positions[p + 2], colors[p], colors[p + 1], colors[p + 2])) break;
    }
    if (i === count) return acc.export(1);
  }
}

// Perceptual-ish rainbow for height coloring. t in [0,1] -> [r,g,b] 0-255
export function heightRamp(t) {
  t = Math.min(1, Math.max(0, t));
  const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
  const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
  const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
  return [r * 255, g * 255, b * 255];
}

// A synthetic "scanned" room so the viewer can be tried on any device.
export function generateDemoRoom(voxelSize = 0.02) {
  const acc = new VoxelAccumulator(voxelSize, 600_000);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = (a) => (rand() - 0.5) * a;
  const step = voxelSize * 0.9;
  const W = 4.2, D = 3.6, H = 2.5;
  const add = (x, y, z, c) => {
    const j = 1 + noise(0.12);
    acc.add(x + noise(0.006), y + noise(0.006), z + noise(0.006), c[0] * j, c[1] * j, c[2] * j);
  };
  // floor: wood planks
  for (let x = -W / 2; x < W / 2; x += step) for (let z = -D / 2; z < D / 2; z += step) {
    const plank = Math.floor((z + 10) / 0.18) % 2;
    add(x, 0, z, plank ? [156, 110, 70] : [140, 96, 60]);
  }
  // rug
  for (let x = -1; x < 0.6; x += step) for (let z = -0.6; z < 0.8; z += step) {
    const stripe = Math.floor((x + 10) / 0.2) % 2;
    add(x, 0.012, z, stripe ? [170, 60, 60] : [215, 200, 170]);
  }
  // walls (back + left), with a window cut-out
  for (let x = -W / 2; x < W / 2; x += step) for (let y = 0; y < H; y += step) {
    const win = x > -0.4 && x < 0.9 && y > 0.9 && y < 2.0;
    add(x, y, -D / 2, win ? [175, 205, 235] : [222, 220, 212]);
  }
  for (let z = -D / 2; z < D / 2; z += step) for (let y = 0; y < H; y += step) {
    const door = z > 0.4 && z < 1.3 && y < 2.05;
    add(-W / 2, y, z, door ? [120, 82, 52] : [205, 214, 206]);
  }
  // table: top + 4 legs
  const tx = 0.9, tz = 0.3, tw = 1.2, td = 0.7, th = 0.74;
  for (let x = tx - tw / 2; x < tx + tw / 2; x += step) for (let z = tz - td / 2; z < tz + td / 2; z += step) {
    add(x, th, z, [90, 62, 44]);
  }
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = tx + lx * (tw / 2 - 0.06), cz = tz + lz * (td / 2 - 0.06);
    for (let y = 0; y < th; y += step) for (let a = 0; a < Math.PI * 2; a += 0.6) {
      add(cx + Math.cos(a) * 0.025, y, cz + Math.sin(a) * 0.025, [70, 48, 34]);
    }
  }
  // sphere "vase" on the table
  const r = 0.14, sc = [tx - 0.2, th + r, tz];
  for (let phi = 0; phi < Math.PI; phi += step / r) for (let th2 = 0; th2 < Math.PI * 2; th2 += step / (r * Math.max(0.2, Math.sin(phi)))) {
    add(sc[0] + r * Math.sin(phi) * Math.cos(th2), sc[1] + r * Math.cos(phi), sc[2] + r * Math.sin(phi) * Math.sin(th2), [40, 120, 160]);
  }
  // box / ottoman
  const bx = -1.2, bz = 0.9, bs = 0.5, bh = 0.42;
  for (let a = 0; a < bs; a += step) for (let b2 = 0; b2 < bs; b2 += step) add(bx + a, bh, bz + b2, [60, 60, 70]);
  for (let a = 0; a < bs; a += step) for (let y = 0; y < bh; y += step) {
    add(bx + a, y, bz, [52, 52, 62]); add(bx + a, y, bz + bs, [52, 52, 62]);
    add(bx, y, bz + a, [48, 48, 58]); add(bx + bs, y, bz + a, [48, 48, 58]);
  }
  return acc.export(1);
}
