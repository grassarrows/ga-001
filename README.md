# DepthScan

A Polycam-style 3D capture tool that runs in the mobile browser. No build step, no server, no uploads: everything stays on the device in IndexedDB.

## Features

- **Live depth scanning** with the WebXR Depth Sensing API (Chrome on ARCore Android phones). Depth frames are unprojected into world space and fused into a voxel grid (1 / 2 / 4 cm) in real time. Points are colored from the camera when the browser grants `camera-access`. A live point preview is drawn over the camera feed.
- **Viewer** for touch screens: one finger orbits, two fingers zoom and pan. Color by captured RGB, height or plain. Point size and grid toggle.
- **Measure**: tap two points to get the distance, plus its vertical and horizontal parts. Switch between metric and imperial.
- **Mesh**: turns a point cloud into a voxel surface mesh.
- **View in AR on iPhone / iPad**: the AR button turns any capture into a USDZ and opens it in Apple's AR Quick Look, placed on your floor at real size. Point scans get a lightweight textured voxel mesh, and heavy imported meshes are resampled to stay under about 10 MB.
- **Import** from other scanner apps (Polycam, 3D Scanner App, Scaniverse): `.ply` (points or mesh), `.obj`, `.glb`, self-contained `.gltf`, `.xyz` / `.pts` / `.txt` / `.csv`.
- **Export**: point clouds as PLY / XYZ, or as a voxel mesh in GLB / OBJ / USDZ. Meshes export as GLB / OBJ / PLY / USDZ or in their original format. On phones, exports open the system share sheet.
- **Installable PWA** that works offline after the first load.
- **Demo scan**, so you can try the app on any device.

## Device support

| Device | Live scan | View / measure / export |
| --- | --- | --- |
| Android + Chrome (ARCore with depth) | ✅ | ✅ |
| iPhone / iPad (Safari) | ❌ iOS doesn't expose LiDAR or WebXR to web pages | ✅ plus **View in AR** (AR Quick Look); capture in a native app and import here |
| Desktop | ❌ | ✅ |

WebXR only runs on **HTTPS** (or `localhost`).

## Run

```sh
npm start            # python3 -m http.server 8080
npm test             # unit tests for the depth/voxel math (Node 18+)
```

To test on a phone, serve it over HTTPS. GitHub Pages works: Settings → Pages → deploy from branch, root folder. Then open the URL in Chrome on Android.

## Layout

```
index.html          app shell (library, AR capture overlay, viewer)
css/app.css         mobile-first dark UI, safe-area aware
js/main.js          UI wiring / navigation
js/scanner.js       WebXR session, depth + camera readback, live preview
js/pointcloud.js    voxel fusion, depth unprojection, voxel mesher, demo data
js/viewer.js        three.js viewer, measuring, display modes
js/exporters.js     PLY/XYZ/GLB/OBJ export, file import
js/store.js         IndexedDB storage
sw.js               offline cache
```
