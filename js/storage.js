/* Where the data lives.

   There is no server and no database. Everything the app remembers lives in a
   folder the user picks, reached through the File System Access API:

     settings.json        models, limits, voices, language, prompts
     decks/<slug>.json    one deck per file
     audio/manifest.json  the dictation bank index
     audio/quota.json     the rolling API call budget
     audio/<id>.wav|.txt  generated speech and its transcript

   The API key is the one thing that never goes in here — it stays in
   localStorage, so pointing the app at a folder that happens to be a git clone
   cannot leak it.

   A directory handle survives a reload but its permission does not always, and
   requestPermission() only works from a user gesture. So restore() reports
   'needs-permission' and the UI turns that into a button the user clicks.

   A browser without that API (Safari, Firefox), or a user who never picks a
   folder, gets the same layout kept in IndexedDB instead: one record per file,
   keyed by the path it would have in the folder. Everything above the paths is
   identical, so a backup zip of either one unzips into a folder the other can
   use. */

const DB_NAME = 'language-study-web';
const HANDLES = 'handles';
const FILES = 'files';
const HANDLE_KEY = 'dataDirHandle';
const KEY_STORAGE = 'lsw.apiKey';

export const SUPPORTS_FS = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/* ── the handle, kept in IndexedDB because handles are structured-cloneable
      and localStorage only holds strings ──────────────────────────────── */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of [HANDLES, FILES]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbRun(store, mode, fn) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const idbPut = (store, key, value) => idbRun(store, 'readwrite', (s) => { s.put(value, key); });
const idbGet = (store, key) => idbRun(store, 'readonly', (s) => s.get(key));
const idbDel = (store, key) => idbRun(store, 'readwrite', (s) => { s.delete(key); });
const idbKeys = (store) => idbRun(store, 'readonly', (s) => s.getAllKeys());

/* ── the folder ──────────────────────────────────────────────────────── */

let dirHandle = null;
/* Set when a folder write fails. Until the user picks a folder again or
   disconnects, writes fail too rather than quietly landing in browser storage
   instead — half the answers in one place and half in the other is worse than
   a clear "reconnect". */
let lost = false;
let browserReady = false;
const listeners = new Set();

export function onFolderChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) {
    try { fn(folderName()); } catch (e) { console.error(e); }
  }
}

export function isConnected() {
  return !!dirHandle;
}

export function folderName() {
  return dirHandle ? dirHandle.name : null;
}

/* 'folder', 'browser', 'lost' (a folder write failed), or null (nothing
   persists: IndexedDB is unavailable, which some private windows still do). */
export function where() {
  if (dirHandle) return 'folder';
  if (lost) return 'lost';
  return browserReady ? 'browser' : null;
}

export async function connect() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'language-study-data' });
  dirHandle = handle;
  lost = false;
  await idbPut(HANDLES, HANDLE_KEY, handle).catch(() => {});
  announce();
  return handle.name;
}

/* Called once at boot. Never prompts — a prompt without a click is refused by
   the browser, and would be rude anyway. */
export async function restore() {
  if (!SUPPORTS_FS) return { state: 'unsupported' };
  let handle = null;
  try { handle = await idbGet(HANDLES, HANDLE_KEY); } catch (e) { handle = null; }
  if (!handle) return { state: 'none' };
  let perm = 'prompt';
  try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { perm = 'prompt'; }
  if (perm === 'granted') {
    dirHandle = handle;
    announce();
    return { state: 'connected', name: handle.name };
  }
  return { state: 'needs-permission', name: handle.name, handle };
}

/* Must be called from a click. */
export async function regrant(handle) {
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;
  dirHandle = handle;
  lost = false;
  announce();
  return true;
}

export async function disconnect() {
  dirHandle = null;
  lost = false;
  await idbDel(HANDLES, HANDLE_KEY).catch(() => {});
  announce();
}

/* A write failing usually means the handle went stale — the folder was moved,
   renamed or the permission was revoked. Drop it so the UI asks for a fresh
   one instead of silently losing every later write too. */
async function invalidate(err) {
  console.error('Folder write failed', err);
  dirHandle = null;
  lost = true;
  await idbDel(HANDLES, HANDLE_KEY).catch(() => {});
  announce();
}

/* ── the browser's own storage ───────────────────────────────────────── */

/* Opens the file store and proves a write goes through. Returns false where
   IndexedDB is missing or refuses, and the app carries on in memory. */
export async function useBrowser() {
  try {
    await idbPut(FILES, '.probe', 1);
    await idbDel(FILES, '.probe');
    browserReady = true;
  } catch (e) {
    console.error('Browser storage unavailable', e);
    browserReady = false;
  }
  return browserReady;
}

/* Asks the browser not to evict this site's storage under pressure. Safari
   and Firefox may say no; the answer is shown, not assumed. */
export async function askPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch (e) { return false; }
}

/* Files are kept as bytes plus a type rather than as Blobs: older Safari
   refused Blobs in IndexedDB in private windows, and bytes work everywhere. */
const browser = {
  async read(path) {
    const rec = await idbGet(FILES, path).catch(() => undefined);
    return rec ? new Blob([rec.bytes], { type: rec.type }) : null;
  },
  async write(path, blob) {
    try {
      await idbPut(FILES, path, { type: blob.type, bytes: await blob.arrayBuffer() });
      return true;
    } catch (e) {
      console.error(`Could not store ${path}`, e);
      return false;
    }
  },
  remove(path) {
    return idbDel(FILES, path).then(() => true, () => false);
  },
  async paths() {
    const keys = await idbKeys(FILES).catch(() => []);
    return keys.filter((k) => typeof k === 'string' && k !== '.probe');
  },
};

/* ── the folder, as the same four operations ─────────────────────────── */

async function resolve(path, { create = false } = {}) {
  if (!dirHandle) return null;
  const parts = path.split('/');
  const file = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create }).catch(() => null);
    if (!dir) return null;
  }
  return dir.getFileHandle(file, { create }).catch(() => null);
}


const folder = {
  async read(path) {
    const handle = await resolve(path);
    if (!handle) return null;
    try { return await handle.getFile(); } catch (e) { return null; }
  },
  async write(path, blob) {
    const handle = await resolve(path, { create: true });
    if (!handle) return false;
    try {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      await invalidate(e);
      return false;
    }
  },
  async remove(path) {
    const parts = path.split('/');
    const file = parts.pop();
    let dir = dirHandle;
    for (const part of parts) {
      if (!dir) return false;
      dir = await dir.getDirectoryHandle(part).catch(() => null);
    }
    if (!dir) return false;
    return dir.removeEntry(file).then(() => true, () => false);
  },
  /* Only the app's own corners of the folder are looked at — if it is a git
     clone or a Documents folder, the rest is none of our business. */
  async paths() {
    if (!dirHandle) return [];
    const out = [];
    if (await resolve('settings.json')) out.push('settings.json');
    for (const sub of ['decks', 'audio']) {
      const dir = await dirHandle.getDirectoryHandle(sub).catch(() => null);
      if (!dir) continue;
      for await (const [name, entry] of dir.entries()) {
        const path = `${sub}/${name}`;
        if (entry.kind === 'file' && dataPath(path) === path) out.push(path);
      }
    }
    return out;
  },
};

function backend() {
  const w = where();
  return w === 'folder' ? folder : w === 'browser' ? browser : null;
}

/* ── files ───────────────────────────────────────────────────────────── */

export async function readText(path) {
  const b = backend();
  const blob = b && await b.read(path);
  if (!blob) return null;
  try { return await blob.text(); } catch (e) { return null; }
}

export async function readJson(path) {
  const text = await readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch (e) {
    console.error(`${path} is not valid JSON`, e);
    return null;
  }
}

export function writeText(path, text) {
  return writeBlob(path, new Blob([text], { type: 'text/plain' }));
}

export function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 2) + '\n');
}

export async function writeBlob(path, blob) {
  const b = backend();
  return b ? b.write(path, blob) : false;
}

export async function readBlob(path) {
  const b = backend();
  return b ? b.read(path) : null;
}

export async function readBlobUrl(path) {
  const blob = await readBlob(path);
  return blob ? URL.createObjectURL(blob) : null;
}

export async function remove(path) {
  const b = backend();
  return b ? b.remove(path) : false;
}

export async function listDecks() {
  const b = backend();
  if (!b) return [];
  return (await b.paths())
    .filter((p) => /^decks\/[^/]+\.json$/.test(p))
    .map((p) => p.slice('decks/'.length, -'.json'.length))
    .sort();
}

/* Folders need decks/ and audio/ to exist before a file can go in them;
   browser storage has no directories to make. */
export async function ensureSubdirs() {
  if (!dirHandle) return;
  await Promise.all(['decks', 'audio'].map((n) => dirHandle.getDirectoryHandle(n, { create: true }).catch(() => null)));
}

/* ── backups ─────────────────────────────────────────────────────────── */

/* The files a backup holds, and the only ones a restore will write. Anything
   else in a folder — a .git, a README, a .DS_Store, the ._name AppleDouble
   files macOS adds when it zips — is not the app's. */
const DATA_PATH = /^(settings\.json|decks\/[^/.][^/]*\.json|audio\/[^/.][^/]*\.(json|wav|txt))$/;

/* Maps a path from a zip or a picked folder onto the data layout, or null.
   Leading folders are dropped, because an unzipped-then-rezipped backup, or a
   folder chosen one level up, nests everything under its own name. */
export function dataPath(raw) {
  const parts = String(raw).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.includes('__MACOSX')) return null;
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (DATA_PATH.test(candidate)) return candidate;
  }
  return null;
}

/* Every data file the current store holds, for a backup. */
export async function allFiles() {
  const b = backend();
  if (!b) return [];
  const out = [];
  for (const path of (await b.paths()).sort()) {
    const blob = await b.read(path);
    if (blob) out.push({ path, data: blob });
  }
  return out;
}

/* Copies what browser storage holds into the current store — used once, when
   an empty folder is connected, so nothing practised before is left behind. */
export async function copyFromBrowser() {
  const b = backend();
  if (!b || b === browser) return 0;
  let n = 0;
  for (const path of await browser.paths()) {
    const blob = await browser.read(path);
    if (blob && await b.write(path, blob)) n++;
  }
  return n;
}

/* ── the API key: localStorage only, never the folder ────────────────── */

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (e) { /* private mode; the key just will not be remembered */ }
}

/* ── small values that must work with no folder connected ────────────── */

export function localGet(key, fallback) {
  try {
    const raw = localStorage.getItem('lsw.' + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}

export function localSet(key, value) {
  try { localStorage.setItem('lsw.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

/* Download as a file — for taking a deck, a sentence or a whole backup out of
   the app. `data` is text or a Blob. */
export function download(filename, data, type = 'application/json') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* Safari starts a large download after the click returns; revoking too
     soon cancels it. */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
