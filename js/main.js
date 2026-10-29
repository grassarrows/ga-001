import { listScans, getScan, putScan, deleteScan, updateScan, newId } from './store.js';
import { generateDemoRoom } from './pointcloud.js';
import { Scanner, depthSupport } from './scanner.js';
import { Viewer } from './viewer.js';
import {
  importFile, saveBlob, pointsToPLY, pointsToXYZ, objectToGLB, objectToOBJ, objectToPLY,
} from './exporters.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- generic UI ----------
function show(id) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
async function busy(text, fn) {
  $('#busy-text').textContent = text;
  $('#busy').classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
  try { return await fn(); } finally { $('#busy').classList.add('hidden'); }
}
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const defaultName = () => `Scan ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

// ---------- library ----------
async function renderGallery() {
  const scans = await listScans();
  const g = $('#gallery');
  g.replaceChildren();
  $('#empty').classList.toggle('hidden', scans.length > 0);
  $('#scan-count').textContent = scans.length ? `${scans.length}` : '';
  for (const s of scans) {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<div class="thumb"><span class="badge"></span></div><div class="info"><div class="name"></div><div class="sub"></div></div>`;
    if (s.thumb) card.querySelector('.thumb').style.backgroundImage = `url(${s.thumb})`;
    card.querySelector('.badge').textContent = s.kind === 'points' ? `${fmtCount(s.count)} pts` : (s.ext || 'mesh').toUpperCase();
    card.querySelector('.name').textContent = s.name;
    card.querySelector('.sub').textContent = fmtDate(s.created);
    card.onclick = () => openScan(s.id);
    g.append(card);
  }
}

async function saveNew(rec) {
  const scan = { id: newId(), name: rec.name || defaultName(), created: Date.now(), ...rec };
  await putScan(scan);
  return scan;
}

// ---------- viewer ----------
let viewer;
let current;

async function openScan(id) {
  const rec = await getScan(id);
  if (!rec) return toast('Capture not found');
  current = rec;
  viewer ??= createViewer();
  show('viewer');
  closePanels();
  setTool('orbit');
  $('#scan-name').value = rec.name;
  $('#scan-meta').textContent = rec.kind === 'points'
    ? `${rec.count.toLocaleString()} points · ${fmtDate(rec.created)}`
    : `${rec.ext.toUpperCase()} mesh · ${fmtDate(rec.created)}`;
  $('#opt-color').querySelector('[value=height]').disabled = rec.kind !== 'points';
  if (rec.kind !== 'points' && $('#opt-color').value === 'height') $('#opt-color').value = 'rgb';
  viewer.colorMode = $('#opt-color').value;
  $('[data-tool=mesh]').classList.toggle('hidden', rec.kind !== 'points');
  try {
    await busy('Loading…', () => viewer.open(rec));
  } catch (e) {
    console.error(e);
    toast(`Could not open: ${e.message}`);
    return goHome();
  }
  updateMeta();
  if (!rec.thumb) {
    await new Promise((r) => requestAnimationFrame(r));
    rec.thumb = viewer.thumbnail();
    updateScan(rec.id, { thumb: rec.thumb });
  }
}

function updateMeta() {
  const dims = viewer.dimensions().map((v) => viewer.formatLength(v)).join(' × ');
  const what = current.kind === 'points' ? `${current.count.toLocaleString()} pts` : `${current.ext.toUpperCase()} mesh`;
  $('#scan-meta').textContent = `${what} · ${dims}`;
}

function createViewer() {
  const v = new Viewer($('#viewer-canvas'));
  v.onMeasure = (m) => {
    const out = $('#measure-readout');
    if (m.hint) {
      out.classList.add('hidden');
      hint(m.hint);
      return;
    }
    out.textContent = v.formatLength(m.distance);
    out.classList.remove('hidden');
    hint(`↕ ${v.formatLength(m.vertical)}   ↔ ${v.formatLength(m.horizontal)}  · tap to start over`);
  };
  return v;
}

function hint(text) {
  const h = $('#tool-hint');
  h.textContent = text;
  h.classList.toggle('hidden', !text);
}

function closePanels(except) {
  for (const id of ['#panel-display', '#panel-export', '#more-menu']) {
    if (id !== except) $(id).classList.add('hidden');
  }
}

function setTool(tool) {
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (!viewer) return;
  viewer.setTool(tool);
  if (tool !== 'measure') {
    viewer.clearMeasure();
    $('#measure-readout').classList.add('hidden');
    hint('');
  } else hint('Tap two points to measure');
}

function goHome() {
  viewer?.stop();
  viewer?.clear();
  current = null;
  show('home');
  renderGallery();
}

$('#btn-back').onclick = goHome;
$('#scan-name').onchange = async (e) => {
  const name = e.target.value.trim() || current.name;
  e.target.value = name;
  current.name = name;
  await updateScan(current.id, { name });
};

$$('.tool').forEach((btn) => {
  btn.onclick = () => {
    const tool = btn.dataset.tool;
    if (tool === 'display' || tool === 'export') {
      const panel = tool === 'display' ? '#panel-display' : '#panel-export';
      closePanels(panel);
      const open = $(panel).classList.toggle('hidden') === false;
      if (tool === 'export' && open) buildExportList();
      return;
    }
    closePanels();
    if (tool === 'mesh') {
      busy('Building mesh…', async () => {
        const on = viewer.toggleVoxelMesh();
        btn.classList.toggle('active', !!on);
        toast(on ? 'Voxel mesh' : 'Point cloud', 1200);
      });
      return;
    }
    setTool(tool);
  };
});

$('#opt-color').onchange = (e) => viewer.setColorMode(e.target.value);
$('#opt-size').oninput = (e) => viewer.setPointSize(+e.target.value);
$('#opt-grid').onchange = (e) => viewer.setGrid(e.target.checked);

$('#btn-more').onclick = () => { closePanels('#more-menu'); $('#more-menu').classList.toggle('hidden'); };
$('#more-menu').onclick = async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  $('#more-menu').classList.add('hidden');
  if (act === 'fit') viewer.fit();
  if (act === 'floor') {
    const rotX = viewer.flipUp();
    viewer.applyColor();
    current.rotX = rotX;
    await updateScan(current.id, { rotX, thumb: viewer.thumbnail() });
    updateMeta();
    toast(rotX ? 'Using Z-up orientation' : 'Using Y-up orientation');
  }
  if (act === 'units') {
    viewer.units = viewer.units === 'metric' ? 'imperial' : 'metric';
    e.target.textContent = `Units: ${viewer.units}`;
    try { localStorage.setItem('units', viewer.units); } catch {}
    updateMeta();
    viewer.measurePts.length === 2 && viewer.onMeasure(measureOf(viewer.measurePts));
  }
  if (act === 'delete') {
    if (!confirm(`Delete “${current.name}”? This can't be undone.`)) return;
    await deleteScan(current.id);
    toast('Deleted');
    goHome();
  }
};
function measureOf([a, b]) {
  const d = a.distanceTo(b), dy = Math.abs(a.y - b.y);
  return { distance: d, vertical: dy, horizontal: Math.sqrt(Math.max(0, d * d - dy * dy)) };
}

const slug = (s) => s.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'scan';

function buildExportList() {
  const list = $('#export-list');
  list.replaceChildren();
  const name = slug(current.name);
  const items = current.kind === 'points'
    ? [
      ['PLY', 'Point cloud, colored', () => pointsToPLY(viewer.worldPositions(), current.colors, current.count), 'ply'],
      ['XYZ', 'Text points + RGB', () => pointsToXYZ(viewer.worldPositions(), current.colors, current.count), 'xyz'],
      ['GLB', 'Voxel mesh', () => objectToGLB(viewer.exportVoxelMesh()), 'glb'],
      ['OBJ', 'Voxel mesh', () => objectToOBJ(viewer.exportVoxelMesh()), 'obj'],
    ]
    : [
      ['GLB', 'Binary glTF', () => objectToGLB(viewer.content), 'glb'],
      ['OBJ', 'Wavefront', () => objectToOBJ(viewer.content), 'obj'],
      ['PLY', 'Mesh', () => objectToPLY(viewer.content), 'ply'],
      ['Original', current.ext.toUpperCase(), () => new Blob([current.data]), current.ext],
    ];
  for (const [label, desc, make, ext] of items) {
    const b = document.createElement('button');
    b.innerHTML = `<b></b><small></small>`;
    b.querySelector('b').textContent = label;
    b.querySelector('small').textContent = desc;
    b.onclick = async () => {
      try {
        const blob = await busy(`Exporting ${label}…`, make);
        await saveBlob(blob, `${name}.${ext}`);
      } catch (e) {
        console.error(e);
        toast(`Export failed: ${e.message}`);
      }
    };
    list.append(b);
  }
}

// ---------- import / demo ----------
$('#file-import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const rec = await busy(`Importing ${file.name}…`, () => importFile(file));
    const scan = await saveNew({ ...rec, name: file.name.replace(/\.[^.]+$/, '') });
    openScan(scan.id);
  } catch (err) {
    console.error(err);
    toast(`Import failed: ${err.message}`, 4000);
  }
};

async function loadDemo() {
  const pc = await busy('Generating demo room…', () => generateDemoRoom(0.02));
  const scan = await saveNew({ kind: 'points', ...pc, name: 'Demo living room' });
  openScan(scan.id);
}
$('#btn-demo').onclick = loadDemo;
$('#btn-demo-dock').onclick = loadDemo;

// ---------- capture ----------
let scanner;
let support = { ok: false };

$('#btn-new-scan').onclick = async () => {
  if (!support.ok) {
    $('#about').classList.remove('hidden');
    return;
  }
  scanner = new Scanner($('#scan'), {
    onStats: (s) => {
      const t = Math.floor(s.ms / 1000);
      const el = $('#scan-stats');
      el.textContent = `${fmtCount(s.points)} pts · ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      el.classList.toggle('rec', s.recording);
      if (s.full) $('#scan-hint').textContent = 'Point budget reached — tap Done';
    },
    onEnd: async (result) => {
      scanner = null;
      $('#btn-record').classList.remove('on');
      if (!result) return goHome();
      const scan = await saveNew({ kind: 'points', ...result });
      toast(`Saved ${fmtCount(result.count)} points`);
      openScan(scan.id);
    },
  });
  scanner.setVoxelSize(+$('#opt-voxel').value);
  scanner.maxDepth = +$('#opt-range').value;
  scanner.preview = $('#opt-preview').checked;
  $('#scan-hint').textContent = 'Tap ● to start capturing';
  $('#scan-stats').textContent = '0 pts · 0:00';
  $('#scan-settings').classList.add('hidden');
  show('scan');
  try {
    await scanner.start();
  } catch (e) {
    console.error(e);
    scanner = null;
    show('home');
    toast(`Couldn't start AR: ${e.message}`, 4500);
  }
};

$('#btn-record').onclick = () => {
  if (!scanner) return;
  const on = scanner.toggleRecord();
  $('#btn-record').classList.toggle('on', on);
  $('#scan-hint').textContent = on ? 'Move slowly · sweep across every surface' : 'Paused — tap ● to continue';
  $('#scan-settings').classList.add('hidden');
  scanner.emitStats();
};
$('#btn-scan-done').onclick = () => {
  if (!scanner) return;
  if (!scanner.acc?.count) return toast('Nothing captured yet — tap ● first');
  scanner.end(true);
};
$('#btn-scan-cancel').onclick = () => {
  if (scanner?.acc?.count > 0 && !confirm('Discard this capture?')) return;
  scanner ? scanner.end(false) : goHome();
};
$('#btn-scan-reset').onclick = () => scanner?.reset();
$('#btn-scan-settings').onclick = () => $('#scan-settings').classList.toggle('hidden');
$('#opt-voxel').onchange = (e) => {
  if (!scanner) return;
  if (scanner.acc.count) toast('Detail applies after Reset');
  scanner.setVoxelSize(+e.target.value);
};
$('#opt-range').onchange = (e) => scanner && (scanner.maxDepth = +e.target.value);
$('#opt-preview').onchange = (e) => scanner && (scanner.preview = e.target.checked);

// ---------- about / boot ----------
$('#btn-about').onclick = () => $('#about').classList.remove('hidden');
$('#btn-about-close').onclick = () => $('#about').classList.add('hidden');
$('#about').onclick = (e) => e.target.id === 'about' && $('#about').classList.add('hidden');

(async function boot() {
  renderGallery();
  try {
    const u = localStorage.getItem('units');
    if (u === 'imperial') {
      viewer ??= createViewer();
      viewer.units = u;
      $('[data-act=units]').textContent = 'Units: imperial';
    }
  } catch {}
  support = await depthSupport();
  if (!support.ok) {
    const b = $('#support-banner');
    b.textContent = `Live scanning unavailable: ${support.reason}`;
    b.classList.remove('hidden');
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
