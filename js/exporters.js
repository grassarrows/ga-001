// File export + import helpers.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function pointsToPLY(positions, colors, count) {
  const header =
    'ply\nformat binary_little_endian 1.0\ncomment DepthScan\n' +
    `element vertex ${count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const head = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(head.length + count * 15);
  new Uint8Array(buf).set(head);
  const dv = new DataView(buf);
  let o = head.length;
  for (let i = 0; i < count; i++) {
    dv.setFloat32(o, positions[i * 3], true);
    dv.setFloat32(o + 4, positions[i * 3 + 1], true);
    dv.setFloat32(o + 8, positions[i * 3 + 2], true);
    dv.setUint8(o + 12, colors[i * 3]);
    dv.setUint8(o + 13, colors[i * 3 + 1]);
    dv.setUint8(o + 14, colors[i * 3 + 2]);
    o += 15;
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

export function pointsToXYZ(positions, colors, count) {
  const lines = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = i * 3;
    lines[i] = `${positions[p].toFixed(4)} ${positions[p + 1].toFixed(4)} ${positions[p + 2].toFixed(4)} ${colors[p]} ${colors[p + 1]} ${colors[p + 2]}`;
  }
  return new Blob([lines.join('\n')], { type: 'text/plain' });
}

export function objectToGLB(object) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(object, (glb) => resolve(new Blob([glb], { type: 'model/gltf-binary' })), reject, { binary: true });
  });
}

export function objectToOBJ(object) {
  return new Blob([new OBJExporter().parse(object)], { type: 'text/plain' });
}

export function objectToPLY(object) {
  return new Promise((resolve) => {
    new PLYExporter().parse(object, (data) => resolve(new Blob([data], { type: 'application/octet-stream' })), { binary: true });
  });
}

export async function objectToUSDZ(object) {
  const data = await new USDZExporter().parse(object, { quickLookCompatible: true });
  return new Blob([data], { type: 'model/vnd.usdz+zip' });
}

// True on iPhone / iPad Safari (and other WebKit iOS browsers) with AR Quick Look.
export const supportsQuickLook = (() => {
  try { return document.createElement('a').relList.supports('ar'); } catch { return false; }
})();

// Shares on mobile when possible (lands in Files / AirDrop / Drive), else downloads.
export async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- import ----------

function parseXYZ(text) {
  const pos = [], col = [];
  let hasColor = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^[#/a-zA-Z]/.test(t)) continue;
    const v = t.split(/[\s,;]+/).map(Number);
    if (v.length < 3 || v.slice(0, 3).some(Number.isNaN)) continue;
    pos.push(v[0], v[1], v[2]);
    // .pts has an intensity column before rgb: x y z i r g b
    const c = v.length >= 7 ? v.slice(4, 7) : v.length >= 6 ? v.slice(3, 6) : null;
    if (c && c.every((n) => !Number.isNaN(n))) {
      hasColor = true;
      const scale = c.every((n) => n <= 1) ? 255 : 1;
      col.push(c[0] * scale, c[1] * scale, c[2] * scale);
    } else col.push(200, 200, 200);
  }
  return { positions: new Float32Array(pos), colors: Uint8Array.from(col), count: pos.length / 3, hasColor };
}

function geometryToPoints(geo) {
  const p = geo.getAttribute('position');
  const c = geo.getAttribute('color');
  const count = p.count;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3).fill(200);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = p.getX(i); positions[i * 3 + 1] = p.getY(i); positions[i * 3 + 2] = p.getZ(i);
    if (c) {
      colors[i * 3] = c.getX(i) * 255; colors[i * 3 + 1] = c.getY(i) * 255; colors[i * 3 + 2] = c.getZ(i) * 255;
    }
  }
  return { positions, colors, count };
}

// Estimates a voxel size from bounding-box density so mesh/point sizes look right.
export function estimateSpacing(positions, count) {
  const box = new THREE.Box3().setFromArray(positions.subarray(0, count * 3));
  const size = box.getSize(new THREE.Vector3());
  const area = Math.max(size.x * size.y, size.y * size.z, size.x * size.z) * 3 || 1;
  return Math.min(0.1, Math.max(0.002, Math.sqrt(area / Math.max(1, count))));
}

// Returns a record ready for the store (minus id/name/created).
export async function importFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['xyz', 'pts', 'txt', 'csv'].includes(ext)) {
    const pc = parseXYZ(await file.text());
    if (!pc.count) throw new Error('No points found in file');
    return { kind: 'points', ...pc, voxelSize: estimateSpacing(pc.positions, pc.count) };
  }
  const data = await file.arrayBuffer();
  if (ext === 'ply') {
    const geo = new PLYLoader().parse(data);
    if (!geo.index) {
      const pc = geometryToPoints(geo);
      return { kind: 'points', ...pc, voxelSize: estimateSpacing(pc.positions, pc.count) };
    }
  } else if (ext === 'gltf') {
    const json = JSON.parse(new TextDecoder().decode(data));
    if ((json.buffers || []).some((b) => b.uri && !b.uri.startsWith('data:'))) {
      throw new Error('This .gltf references external files — export as .glb instead');
    }
  } else if (!['obj', 'glb'].includes(ext)) {
    throw new Error(`Unsupported file type .${ext}`);
  }
  return { kind: 'mesh', data, ext };
}

// Builds a three.js object for a stored mesh record.
export async function loadMeshObject(rec) {
  if (rec.ext === 'ply') {
    const geo = new PLYLoader().parse(rec.data);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: !!geo.getAttribute('color'), roughness: 0.9, side: THREE.DoubleSide });
    return new THREE.Mesh(geo, mat);
  }
  if (rec.ext === 'obj') {
    const obj = new OBJLoader().parse(new TextDecoder().decode(rec.data));
    obj.traverse((o) => {
      if (o.isMesh) {
        if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
        o.material = new THREE.MeshStandardMaterial({ vertexColors: !!o.geometry.getAttribute('color'), color: 0xd0d4da, roughness: 0.9, side: THREE.DoubleSide });
      }
    });
    return obj;
  }
  const gltf = await new GLTFLoader().parseAsync(rec.data, '');
  return gltf.scene;
}
