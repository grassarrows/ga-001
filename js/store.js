// Tiny IndexedDB wrapper. Records:
//   { id, name, created, kind: 'points', positions, colors, count, voxelSize, thumb }
//   { id, name, created, kind: 'mesh', data: ArrayBuffer, ext, thumb }

const DB = 'depthscan';
const STORE = 'scans';
let dbp;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const putScan = (scan) => tx('readwrite', (s) => s.put(scan));
export const getScan = (id) => tx('readonly', (s) => s.get(id));
export const deleteScan = (id) => tx('readwrite', (s) => s.delete(id));

// Lightweight listing without loading every scan's geometry into the page.
export async function listScans() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = d.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(out.sort((a, b) => b.created - a.created));
      const { id, name, created, kind, count, thumb, ext } = c.value;
      out.push({ id, name, created, kind, count, thumb, ext });
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateScan(id, patch) {
  const scan = await getScan(id);
  if (!scan) return;
  Object.assign(scan, patch);
  await putScan(scan);
  return scan;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
