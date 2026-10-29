// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelAccumulator, unprojectDepth, buildVoxelMesh, voxelKey, downsampleToBudget } from '../js/pointcloud.js';

// Column-major perspective matrix (same layout as WebXR / three.js)
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function invertPerspective(m) {
  // closed-form inverse for the matrix above
  const a = m[0], b = m[5], c = m[10], d = m[14];
  return [1 / a, 0, 0, 0, 0, 1 / b, 0, 0, 0, 0, 0, 1 / d, 0, 0, -1, c / d];
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('flat wall at 2 m unprojects to z = -2 within the frustum', () => {
  const P = perspective(Math.PI / 2, 1, 0.1, 100);
  const pts = [];
  unprojectDepth({ width: 32, height: 32, depthAt: () => 2, invProj: invertPerspective(P), worldFromView: identity }, (x, y, z) => pts.push([x, y, z]));
  assert.equal(pts.length, 32 * 32);
  for (const [x, y, z] of pts) {
    assert.ok(Math.abs(z + 2) < 1e-9);
    assert.ok(Math.abs(x) <= 2 && Math.abs(y) <= 2); // 90° fov -> half-width = depth
  }
  // top-left sample (v small) must be up (+y) and left (-x)
  assert.ok(pts[0][0] < 0 && pts[0][1] > 0);
});

test('camera transform is applied (translated + yawed 90° left)', () => {
  const P = perspective(Math.PI / 3, 1, 0.1, 100);
  // rotate +90° about Y: view -Z maps to world -X; then translate by (5, 1, 0)
  const M = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 1, 0, 1];
  const pts = [];
  unprojectDepth({ width: 1, height: 1, depthAt: () => 3, invProj: invertPerspective(P), worldFromView: M }, (x, y, z) => pts.push([x, y, z]));
  const [x, y, z] = pts[0];
  assert.ok(Math.abs(x - 2) < 1e-9 && Math.abs(y - 1) < 1e-9 && Math.abs(z) < 1e-9, `${x},${y},${z}`);
});

test('depth outside range is rejected', () => {
  const P = perspective(1, 1, 0.1, 100);
  let n = 0;
  unprojectDepth({ width: 8, height: 8, depthAt: (u) => (u < 0.5 ? 0 : 9), invProj: invertPerspective(P), worldFromView: identity, maxDepth: 5 }, () => n++);
  assert.equal(n, 0);
});

test('accumulator averages samples in one voxel and filters by hits', () => {
  const acc = new VoxelAccumulator(0.1, 100);
  acc.add(0.01, 0.01, 0.01, 0, 0, 0);
  acc.add(0.03, 0.03, 0.03, 100, 100, 100);
  acc.add(0.55, 0, 0, 50, 50, 50);
  assert.equal(acc.count, 2);
  assert.ok(Math.abs(acc.positions[0] - 0.02) < 1e-6);
  assert.equal(acc.colors[0], 50);
  // fewer than 50 voxels -> keeps all regardless of minHits
  assert.equal(acc.export(2).count, 2);
});

test('voxel keys are unique for negative/positive neighbours', () => {
  const keys = new Set();
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) keys.add(voxelKey(x, y, z));
  assert.equal(keys.size, 125);
});

test('voxel mesh of a single voxel is a closed cube; two adjacent share no face', () => {
  const one = buildVoxelMesh(new Float32Array([0.05, 0.05, 0.05]), new Uint8Array([255, 0, 0]), 1, 0.1);
  assert.equal(one.index.length, 6 * 6);
  const two = buildVoxelMesh(new Float32Array([0.05, 0.05, 0.05, 0.15, 0.05, 0.05]), new Uint8Array(6), 2, 0.1);
  assert.equal(two.index.length, 10 * 6);
  // outward winding: +X face normal from cross product matches stored normal
  const p = one.positions, i = one.index;
  const v = (k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]];
  for (let f = 0; f < i.length; f += 6) {
    const [a, b, c] = [v(i[f]), v(i[f + 1]), v(i[f + 2])];
    const e1 = b.map((x, k) => x - a[k]), e2 = c.map((x, k) => x - a[k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const sn = [one.normals[i[f] * 3], one.normals[i[f] * 3 + 1], one.normals[i[f] * 3 + 2]];
    assert.ok(n[0] * sn[0] + n[1] * sn[1] + n[2] * sn[2] > 0, `face ${f / 6} winding`);
  }
});

test('downsampleToBudget coarsens until the cloud fits', () => {
  const n = 100 * 100, pos = new Float32Array(n * 3), col = new Uint8Array(n * 3).fill(128);
  for (let i = 0; i < n; i++) { pos[i * 3] = (i % 100) * 0.01 + 0.005; pos[i * 3 + 2] = Math.floor(i / 100) * 0.01 + 0.005; }
  const fine = downsampleToBudget(pos, col, n, 0.01, 20000);
  assert.equal(fine.count, n);
  assert.equal(fine.voxelSize, 0.01);
  const coarse = downsampleToBudget(pos, col, n, 0.01, 1000);
  assert.ok(coarse.count <= 1000 && coarse.voxelSize > 0.01);
  // every mesh vertex points back at a real voxel
  const m = buildVoxelMesh(coarse.positions, coarse.colors, coarse.count, coarse.voxelSize);
  assert.equal(m.source.length, m.positions.length / 3);
  assert.ok(Math.max(...m.source) < coarse.count);
});
