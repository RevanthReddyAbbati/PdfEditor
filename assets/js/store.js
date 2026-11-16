// Minimal IndexedDB key/value store. Everything stays in the user's browser.
const DB_NAME = 'folio-pdf';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const kv = {
  get: key => tx('readonly', s => s.get(key)).catch(() => undefined),
  set: (key, value) => tx('readwrite', s => s.put(value, key)).catch(() => undefined),
  del: key => tx('readwrite', s => s.delete(key)).catch(() => undefined),
};
