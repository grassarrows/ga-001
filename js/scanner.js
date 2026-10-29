// Live capture via WebXR immersive-ar + depth-sensing (Chrome / ARCore).
import * as THREE from 'three';
import { VoxelAccumulator, unprojectDepth } from './pointcloud.js';

export async function depthSupport() {
  if (!navigator.xr) return { ok: false, reason: 'This browser has no WebXR. Use Chrome on an ARCore Android phone, or import a scan.' };
  try {
    const ar = await navigator.xr.isSessionSupported('immersive-ar');
    if (!ar) return { ok: false, reason: 'AR sessions are not supported on this device. You can still import and view scans.' };
  } catch {
    return { ok: false, reason: 'WebXR is blocked here (needs HTTPS).' };
  }
  return { ok: true };
}

const CAM_W = 192, CAM_H = 144; // downsampled camera image used for coloring

export class Scanner {
  constructor(overlay, { onStats, onEnd }) {
    this.overlay = overlay;
    this.onStats = onStats;
    this.onEnd = onEnd;
    this.recording = false;
    this.voxelSize = 0.02;
    this.maxDepth = 3.5;
    this.preview = true;
    this.captureInterval = 150;
    this.lastCapture = 0;
    this.frames = 0;
    this.startedAt = 0;
    this.recordMs = 0;
  }

  async start() {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['depth-sensing'],
      optionalFeatures: ['dom-overlay', 'camera-access', 'local-floor'],
      domOverlay: { root: this.overlay },
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
    });
    this.session = session;
    this.acc = new VoxelAccumulator(this.voxelSize);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    renderer.setPixelRatio(1);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    this.renderer = renderer;
    this.gl = renderer.getContext();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.buildPreview();

    await renderer.xr.setSession(session);
    this.hasCamera = !!session.enabledFeatures?.includes('camera-access') && typeof XRWebGLBinding !== 'undefined';
    if (this.hasCamera) {
      try { this.glBinding = new XRWebGLBinding(session, this.gl); } catch { this.hasCamera = false; }
    }
    this.camPixels = new Uint8Array(CAM_W * CAM_H * 4);

    session.addEventListener('end', () => this.cleanup());
    renderer.setAnimationLoop((t, frame) => this.onFrame(t, frame));
  }

  buildPreview() {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.acc.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.acc.colors, 3, true).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never frustum-cull
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: this.voxelSize * 1.1, vertexColors: true, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.uploaded = 0;
  }

  setVoxelSize(s) {
    this.voxelSize = s;
    if (this.acc && this.acc.count === 0) {
      this.acc.voxelSize = s;
      this.points.material.size = s * 1.1;
    }
  }

  toggleRecord() {
    this.recording = !this.recording;
    if (this.recording) this.startedAt = performance.now();
    else this.recordMs += performance.now() - this.startedAt;
    return this.recording;
  }

  reset() {
    this.acc.reset();
    this.acc.voxelSize = this.voxelSize;
    this.points.material.size = this.voxelSize * 1.1;
    this.syncPreview();
    this.recordMs = 0;
    this.startedAt = performance.now();
    this.frames = 0;
    this.emitStats();
  }

  elapsed() {
    return this.recordMs + (this.recording ? performance.now() - this.startedAt : 0);
  }

  emitStats() {
    this.onStats?.({ points: this.acc.count, frames: this.frames, ms: this.elapsed(), recording: this.recording, full: this.acc.full, color: this.hasCamera });
  }

  onFrame(t, frame) {
    if (!frame) return;
    const refSpace = this.renderer.xr.getReferenceSpace();
    const pose = frame.getViewerPose(refSpace);

    if (pose && this.recording && !pose.emulatedPosition && t - this.lastCapture >= this.captureInterval && !this.acc.full) {
      this.lastCapture = t;
      for (const view of pose.views) this.captureView(frame, view);
      this.frames++;
      this.emitStats();
    }

    if (this.preview && this.uploaded !== this.acc.count) this.syncPreview();
    this.points.visible = this.preview;
    this.renderer.render(this.scene, this.camera);
  }

  captureView(frame, view) {
    let depth;
    try { depth = frame.getDepthInformation(view); } catch { return; }
    if (!depth) return;

    const colorAt = this.readCameraImage(view) ? (u, v, out) => {
      // camera texture is bottom-left origin
      const x = Math.min(CAM_W - 1, (u * CAM_W) | 0);
      const y = Math.min(CAM_H - 1, ((1 - v) * CAM_H) | 0);
      const o = (y * CAM_W + x) * 4;
      out[0] = this.camPixels[o]; out[1] = this.camPixels[o + 1]; out[2] = this.camPixels[o + 2];
    } : null;

    const invProj = new THREE.Matrix4().fromArray(view.projectionMatrix).invert().elements;
    const acc = this.acc;
    unprojectDepth({
      width: depth.width,
      height: depth.height,
      depthAt: (u, v) => depth.getDepthInMeters(u, v),
      invProj,
      worldFromView: view.transform.matrix,
      colorAt,
      maxDepth: this.maxDepth,
    }, (x, y, z, r, g, b) => acc.add(x, y, z, r, g, b));
  }

  // Copies the camera frame (camera-access feature) into a small RGBA buffer.
  readCameraImage(view) {
    if (!this.hasCamera || !view.camera) return false;
    const gl = this.gl;
    let tex;
    try { tex = this.glBinding.getCameraImage(view.camera); } catch { return false; }
    if (!tex) return false;

    const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
    try {
      if (!this.srcFb) {
        this.srcFb = gl.createFramebuffer();
        this.dstFb = gl.createFramebuffer();
        this.dstRb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.dstRb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, CAM_W, CAM_H);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dstFb);
        gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.dstRb);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.srcFb);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.dstFb);
      gl.blitFramebuffer(0, 0, view.camera.width, view.camera.height, 0, 0, CAM_W, CAM_H, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.dstFb);
      gl.readPixels(0, 0, CAM_W, CAM_H, gl.RGBA, gl.UNSIGNED_BYTE, this.camPixels);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.srcFb);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      return gl.getError() === gl.NO_ERROR;
    } catch {
      this.hasCamera = false;
      return false;
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
      gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
    }
  }

  // Uploads only newly added points; re-averaged older voxels move by a
  // fraction of a voxel, which isn't worth re-uploading the whole buffer for.
  syncPreview() {
    const acc = this.acc;
    if (acc.count < this.uploaded) this.uploaded = 0;
    const from = this.uploaded, n = acc.count - from;
    for (const a of [this.posAttr, this.colAttr]) {
      a.clearUpdateRanges();
      a.addUpdateRange(from * 3, n * 3);
      a.needsUpdate = true;
    }
    this.points.geometry.setDrawRange(0, acc.count);
    this.uploaded = acc.count;
  }

  // Ends the AR session. onEnd receives the fused cloud, or null when
  // cancelled / empty. Ending from the system (back gesture) keeps the scan.
  end(keep = true) {
    this.keep = keep;
    if (this.session) this.session.end().catch(() => this.cleanup());
    else this.cleanup();
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    const keep = this.keep !== false && this.acc && this.acc.count > 0;
    const result = keep ? this.acc.export(2) : null;
    this.renderer?.setAnimationLoop(null);
    this.points?.geometry.dispose();
    this.points?.material.dispose();
    this.renderer?.dispose();
    this.onEnd?.(result);
  }
}
