// Touch-friendly 3D viewer: orbit, measure, display options, voxel meshing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildVoxelMesh, heightRamp, downsampleToBudget } from './pointcloud.js';
import { loadMeshObject } from './exporters.js';

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);

    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);

    this.colorMode = 'rgb';
    this.sizeFactor = 2;
    this.units = 'metric';
    this.tool = 'orbit';
    this.measurePts = [];
    this.raycaster = new THREE.Raycaster();
    this.origMats = new WeakMap(); // not userData: clone() JSON-copies that

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop() { this.renderer.setAnimationLoop(null); }

  clear() {
    this.content.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
    this.content.clear();
    this.content.rotation.set(0, 0, 0);
    this.clearMeasure();
    this.points = this.mesh = this.voxelMesh = this.grid = null;
  }

  async open(rec) {
    this.clear();
    this.rec = rec;
    if (rec.kind === 'points') {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(rec.positions, 3));
      this.rgb = rec.colors;
      geo.setAttribute('color', new THREE.BufferAttribute(rec.colors, 3, true));
      this.points = new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, sizeAttenuation: true }));
      this.content.add(this.points);
    } else {
      this.mesh = await loadMeshObject(rec);
      this.content.add(this.mesh);
    }
    this.content.rotation.x = rec.rotX || 0;
    this.content.updateMatrixWorld(true);
    this.spacing = rec.voxelSize || this.estimateMeshScale();
    this.applyColor();
    this.applySize();
    this.addGrid();
    this.fit();
    this.start();
  }

  estimateMeshScale() {
    const r = new THREE.Box3().setFromObject(this.content).getBoundingSphere(new THREE.Sphere()).radius;
    return Math.max(0.002, r / 300);
  }

  get bounds() {
    this.content.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.content, true);
  }

  dimensions() {
    const s = this.bounds.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z];
  }

  addGrid() {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); }
    const b = this.bounds, size = b.getSize(new THREE.Vector3());
    const span = Math.max(1, Math.ceil(Math.max(size.x, size.z) * 1.4));
    this.grid = new THREE.GridHelper(span, span * 2, 0x3a4250, 0x232830);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.7;
    const c = b.getCenter(new THREE.Vector3());
    this.grid.position.set(c.x, b.min.y - 0.002, c.z);
    this.grid.visible = this.showGrid ?? true;
    this.scene.add(this.grid);
  }

  setGrid(on) { this.showGrid = on; if (this.grid) this.grid.visible = on; }

  fit() {
    const sphere = this.bounds.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 0.05);
    this.radius = r;
    const dir = new THREE.Vector3(0.6, 0.55, 1).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(dir, r / Math.sin((this.camera.fov * Math.PI) / 360) * 0.9);
    this.camera.near = r / 200;
    this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.maxDistance = r * 10;
    this.controls.update();
  }

  flipUp() {
    this.content.rotation.x = this.content.rotation.x ? 0 : -Math.PI / 2;
    this.addGrid();
    this.fit();
    return this.content.rotation.x;
  }

  // ---------- display ----------
  setColorMode(mode) { this.colorMode = mode; this.applyColor(); }

  applyColor() {
    if (this.points) {
      const attr = this.points.geometry.getAttribute('color');
      if (this.colorMode === 'rgb') attr.array = this.rgb;
      else {
        const n = this.rec.count, out = new Uint8Array(n * 3);
        if (this.colorMode === 'plain') out.fill(215);
        else {
          // flipUp() rotates -90° about X, which maps +Z to world up
          const pos = this.rec.positions, axis = this.content.rotation.x ? 2 : 1;
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < n; i++) { const v = pos[i * 3 + axis]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const span = hi - lo || 1;
          for (let i = 0; i < n; i++) out.set(heightRamp((pos[i * 3 + axis] - lo) / span), i * 3);
        }
        attr.array = out;
      }
      attr.needsUpdate = true;
    }
    const plain = this.colorMode === 'plain';
    for (const obj of [this.mesh, this.voxelMesh]) {
      obj?.traverse((o) => {
        if (!o.isMesh) return;
        if (!this.origMats.has(o)) this.origMats.set(o, o.material);
        o.material = plain ? (this.plainMat ??= new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.85, side: THREE.DoubleSide })) : this.origMats.get(o);
      });
    }
  }

  setPointSize(f) { this.sizeFactor = f; this.applySize(); }
  applySize() { if (this.points) this.points.material.size = this.spacing * this.sizeFactor; }

  // Toggles a blocky voxel surface built from the point cloud.
  toggleVoxelMesh() {
    if (!this.points) return null;
    if (!this.voxelMesh) {
      const m = buildVoxelMesh(this.rec.positions, this.rgb, this.rec.count, this.spacing);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
      geo.setIndex(new THREE.BufferAttribute(m.index, 1));
      this.voxelMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
      this.voxelMesh.visible = false;
      this.content.add(this.voxelMesh);
      this.applyColor();
    }
    this.voxelMesh.visible = !this.voxelMesh.visible;
    this.points.visible = !this.voxelMesh.visible;
    return this.voxelMesh.visible;
  }

  // Standalone copy of the voxel mesh with the content transform baked in.
  exportVoxelMesh() {
    if (!this.voxelMesh) { this.toggleVoxelMesh(); this.toggleVoxelMesh(); }
    const geo = this.voxelMesh.geometry.clone().applyMatrix4(this.content.matrixWorld);
    // glTF vertex colors are linear; ours are sRGB camera values.
    const col = geo.getAttribute('color'), c = new THREE.Color();
    for (let i = 0; i < col.count; i++) {
      c.fromBufferAttribute(col, i).convertSRGBToLinear();
      col.setXYZ(i, c.r, c.g, c.b);
    }
    return new THREE.Mesh(geo, this.origMats.get(this.voxelMesh) || this.voxelMesh.material);
  }

  // Textured, floor-anchored copy of the scan for USDZ / AR Quick Look.
  // Quick Look has no vertex colors, so voxel colors are baked into a texture.
  buildARObject(budget = 20000) {
    const root = new THREE.Group();
    if (this.points) {
      const ds = downsampleToBudget(this.worldPositions(), this.rgb, this.rec.count, this.spacing, budget);
      const m = buildVoxelMesh(ds.positions, ds.colors, ds.count, ds.voxelSize);
      const cols = Math.ceil(Math.sqrt(ds.count));
      const cell = Math.max(1, Math.min(4, Math.floor(1024 / cols))); // >1px cells limit mipmap bleed
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = cols * cell;
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < ds.count; i++) {
        const c = ds.colors;
        ctx.fillStyle = `rgb(${c[i * 3]},${c[i * 3 + 1]},${c[i * 3 + 2]})`;
        ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
      }
      const uv = new Float32Array(m.source.length * 2);
      for (let k = 0; k < m.source.length; k++) {
        const i = m.source[k];
        uv[k * 2] = ((i % cols) + 0.5) / cols;
        uv[k * 2 + 1] = 1 - (Math.floor(i / cols) + 0.5) / cols; // texture is flipped on export
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(m.index, 1));
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, roughness: 1 })));
    } else if (!this.meshIsLight()) {
      // Too heavy (or colored per-vertex, which Quick Look ignores): resample the
      // surface into a cloud and send it through the textured voxel path above.
      const cloud = this.sampleMeshSurface(budget * 20);
      const keep = { points: this.points, rgb: this.rgb, rec: this.rec, spacing: this.spacing };
      const area = cloud.area;
      Object.assign(this, {
        points: true, rgb: cloud.colors, rec: { positions: cloud.positions, count: cloud.count },
        spacing: Math.max(0.005, Math.sqrt(area / budget) / 2),
      });
      const rot = this.content.rotation.x;
      this.content.rotation.x = 0; // samples are already in world space
      this.content.updateMatrixWorld(true);
      try { return this.buildARObject(budget); } finally {
        Object.assign(this, keep);
        this.content.rotation.x = rot;
        this.content.updateMatrixWorld(true);
      }
    } else {
      this.content.updateMatrixWorld(true);
      this.content.traverse((o) => {
        if (!o.isMesh) return;
        const mat = this.origMats.get(o) || o.material;
        const src = Array.isArray(mat) ? mat[0] : mat;
        const std = src.isMeshStandardMaterial ? src
          : new THREE.MeshStandardMaterial({ color: src.color ?? 0xc9ced6, map: src.map ?? null, roughness: 0.9 });
        const mesh = new THREE.Mesh(o.geometry, std);
        o.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
        root.add(mesh);
      });
    }
    // Sit the model on the detected floor, centered on the anchor.
    const wrap = new THREE.Group();
    wrap.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    root.position.set(-c.x, -box.min.y, -c.z);
    wrap.updateMatrixWorld(true);
    return wrap;
  }

  // Meshes Quick Look can take as-is: modest size, colors from textures/materials.
  meshIsLight(maxVerts = 300_000) {
    let verts = 0, vertexColored = false;
    this.content.traverse((o) => {
      if (!o.isMesh) return;
      verts += o.geometry.getAttribute('position').count;
      const mat = this.origMats.get(o) || o.material;
      if (o.geometry.getAttribute('color') && [].concat(mat).some((m) => m.vertexColors && !m.map)) vertexColored = true;
    });
    return verts <= maxVerts && !vertexColored;
  }

  // Area-weighted random points on every triangle (world space), colored from
  // vertex colors, the texture at that UV, or the material color.
  sampleMeshSurface(target) {
    const meshes = [];
    let total = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), t = new THREE.Triangle();
    this.content.updateMatrixWorld(true);
    this.content.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry, pos = g.getAttribute('position'), idx = g.index;
      const tris = idx ? idx.count / 3 : pos.count / 3;
      const areas = new Float32Array(tris);
      for (let f = 0; f < tris; f++) {
        const [i0, i1, i2] = idx ? [idx.getX(f * 3), idx.getX(f * 3 + 1), idx.getX(f * 3 + 2)] : [f * 3, f * 3 + 1, f * 3 + 2];
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        areas[f] = t.set(a, b, c).getArea();
        total += areas[f];
      }
      const mat = [].concat(this.origMats.get(o) || o.material)[0];
      meshes.push({ o, areas, mat, tex: textureSampler(mat.map) });
    });
    const pts = [], cols = [];
    const uvA = new THREE.Vector2(), uvB = new THREE.Vector2(), uvC = new THREE.Vector2(), rgb = [0, 0, 0];
    const p = new THREE.Vector3(), col = new THREE.Color();
    for (const { o, areas, mat, tex } of meshes) {
      const g = o.geometry, pos = g.getAttribute('position'), idx = g.index, uv = g.getAttribute('uv'), vc = g.getAttribute('color');
      const base = mat.color ? mat.color.clone().convertLinearToSRGB() : new THREE.Color(0.8, 0.8, 0.8);
      for (let f = 0; f < areas.length; f++) {
        const want = (areas[f] / total) * target;
        let n = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
        if (!n) continue;
        const [i0, i1, i2] = idx ? [idx.getX(f * 3), idx.getX(f * 3 + 1), idx.getX(f * 3 + 2)] : [f * 3, f * 3 + 1, f * 3 + 2];
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        if (uv) { uvA.fromBufferAttribute(uv, i0); uvB.fromBufferAttribute(uv, i1); uvC.fromBufferAttribute(uv, i2); }
        while (n--) {
          let r1 = Math.random(), r2 = Math.random();
          if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
          const r0 = 1 - r1 - r2;
          p.set(0, 0, 0).addScaledVector(a, r0).addScaledVector(b, r1).addScaledVector(c, r2);
          pts.push(p.x, p.y, p.z);
          if (tex && uv) {
            tex(uvA.x * r0 + uvB.x * r1 + uvC.x * r2, uvA.y * r0 + uvB.y * r1 + uvC.y * r2, rgb);
            cols.push(rgb[0] * base.r, rgb[1] * base.g, rgb[2] * base.b);
          } else if (vc) {
            col.setRGB(vc.getX(i0) * r0 + vc.getX(i1) * r1 + vc.getX(i2) * r2, vc.getY(i0) * r0 + vc.getY(i1) * r1 + vc.getY(i2) * r2, vc.getZ(i0) * r0 + vc.getZ(i1) * r1 + vc.getZ(i2) * r2);
            if (vc.normalized || vc.array instanceof Float32Array) col.convertLinearToSRGB();
            cols.push(col.r * 255, col.g * 255, col.b * 255);
          } else cols.push(base.r * 255, base.g * 255, base.b * 255);
        }
      }
    }
    return { positions: new Float32Array(pts), colors: Uint8Array.from(cols), count: pts.length / 3, area: total };
  }

  // Positions with the content transform (e.g. flipped up axis) baked in.
  worldPositions() {
    const src = this.rec.positions, out = new Float32Array(this.rec.count * 3);
    const v = new THREE.Vector3(), m = this.content.matrixWorld;
    for (let i = 0; i < this.rec.count; i++) {
      v.fromArray(src, i * 3).applyMatrix4(m).toArray(out, i * 3);
    }
    return out;
  }

  // ---------- measuring ----------
  setTool(tool) {
    this.tool = tool;
    this.controls.enableRotate = true;
  }

  bindPointer() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || this.tool !== 'measure') return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 8 && performance.now() - down.t < 500) this.pick(e.clientX, e.clientY);
      down = null;
    });
  }

  pick(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Points.threshold = this.spacing * 1.5;
    const targets = [this.voxelMesh?.visible ? this.voxelMesh : this.points?.visible ? this.points : null, this.mesh].filter(Boolean);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (!hits.length) return this.onMeasure?.({ hint: 'No surface there — tap on the model' });
    // For points, the closest-to-ray hit within the first few is less jittery.
    const hit = hits.slice(0, 8).sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0))[0];
    this.addMeasurePoint(hit.point.clone());
  }

  addMeasurePoint(p) {
    if (this.measurePts.length >= 2) this.clearMeasure();
    this.measurePts.push(p);
    const rad = (this.radius || 1) * 0.012;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(rad, 16, 12), new THREE.MeshBasicMaterial({ color: 0x36d1a0, depthTest: false }));
    dot.renderOrder = 10;
    dot.position.copy(p);
    this.measureGroup.add(dot);
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0x36d1a0, depthTest: false }));
      line.renderOrder = 9;
      this.measureGroup.add(line);
      const d = a.distanceTo(b), dy = Math.abs(a.y - b.y);
      this.onMeasure?.({ distance: d, vertical: dy, horizontal: Math.sqrt(Math.max(0, d * d - dy * dy)) });
    } else {
      this.onMeasure?.({ hint: 'Tap a second point' });
    }
  }

  clearMeasure() {
    this.measureGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.measureGroup.clear();
    this.measurePts = [];
  }

  formatLength(m) {
    if (this.units === 'imperial') {
      const inches = m / 0.0254;
      const ft = Math.floor(inches / 12);
      return ft ? `${ft}′ ${(inches - ft * 12).toFixed(1)}″` : `${inches.toFixed(1)}″`;
    }
    return m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`;
  }

  // Square JPEG thumbnail of the current view.
  thumbnail(size = 320) {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#12161b';
    ctx.fillRect(0, 0, size, size);
    const src = this.renderer.domElement, s = Math.min(src.width, src.height);
    ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.75);
  }
}

// Returns (u, v, out) -> sRGB 0-255 lookup for a texture's image, or null.
function textureSampler(map) {
  const img = map?.image;
  if (!img?.width) return null;
  const w = Math.min(img.width, 1024), h = Math.round(img.height * (w / img.width));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(img, 0, 0, w, h); } catch { return null; }
  const px = ctx.getImageData(0, 0, w, h).data;
  const flip = map.flipY;
  return (u, v, out) => {
    u -= Math.floor(u); v -= Math.floor(v);
    const x = Math.min(w - 1, (u * w) | 0), y = Math.min(h - 1, ((flip ? 1 - v : v) * h) | 0);
    const o = (y * w + x) * 4;
    out[0] = px[o]; out[1] = px[o + 1]; out[2] = px[o + 2];
  };
}
