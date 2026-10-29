// Touch-friendly 3D viewer: orbit, measure, display options, voxel meshing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildVoxelMesh, heightRamp } from './pointcloud.js';
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
    return new THREE.Mesh(geo, this.origMats.get(this.voxelMesh) || this.voxelMesh.material);
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
