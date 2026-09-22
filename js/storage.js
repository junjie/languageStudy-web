/* The local folder.

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
   'needs-permission' and the UI turns that into a button the user clicks. */

const DB_NAME = 'language-study-web';
const STORE = 'handles';
const HANDLE_KEY = 'dataDirHandle';
const KEY_STORAGE = 'lsw.apiKey';

export const SUPPORTS_FS = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/* ── the handle, kept in IndexedDB because handles are structured-cloneable
      and localStorage only holds strings ──────────────────────────────── */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(key) {
  const db = await idbOpen();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function idbDel(key) {
  const db = await idbOpen();
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  db.close();
}

/* ── the folder ──────────────────────────────────────────────────────── */

let dirHandle = null;
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

export async function connect() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'language-study-data' });
  dirHandle = handle;
  await idbPut(HANDLE_KEY, handle).catch(() => {});
  announce();
  return handle.name;
}

/* Called once at boot. Never prompts — a prompt without a click is refused by
   the browser, and would be rude anyway. */
export async function restore() {
  if (!SUPPORTS_FS) return { state: 'unsupported' };
  let handle = null;
  try { handle = await idbGet(HANDLE_KEY); } catch (e) { handle = null; }
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
  announce();
  return true;
}

export async function disconnect() {
  dirHandle = null;
  await idbDel(HANDLE_KEY).catch(() => {});
  announce();
}

/* A write failing usually means the handle went stale — the folder was moved,
   renamed or the permission was revoked. Drop it so the UI asks for a fresh
   one instead of silently losing every later write too. */
async function invalidate(err) {
  console.error('Folder write failed', err);
  dirHandle = null;
  await idbDel(HANDLE_KEY).catch(() => {});
  announce();
}

async function subdir(name, create) {
  if (!dirHandle) return null;
  try {
    return await dirHandle.getDirectoryHandle(name, { create });
  } catch (e) {
    return null;
  }
}

/* ── files ───────────────────────────────────────────────────────────── */

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

export async function readText(path) {
  const handle = await resolve(path);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    return await file.text();
  } catch (e) {
    return null;
  }
}

export async function readJson(path) {
  const text = await readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch (e) {
    console.error(`${path} is not valid JSON`, e);
    return null;
  }
}

export async function writeText(path, text) {
  const handle = await resolve(path, { create: true });
  if (!handle) return false;
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch (e) {
    await invalidate(e);
    return false;
  }
}

export function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 2) + '\n');
}

export async function writeBlob(path, blob) {
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
}

export async function readBlobUrl(path) {
  const handle = await resolve(path);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    return URL.createObjectURL(file);
  } catch (e) {
    return null;
  }
}

export async function remove(path) {
  const parts = path.split('/');
  const file = parts.pop();
  let dir = dirHandle;
  for (const part of parts) {
    if (!dir) return false;
    dir = await dir.getDirectoryHandle(part).catch(() => null);
  }
  if (!dir) return false;
  return dir.removeEntry(file).then(() => true, () => false);
}

export async function listDecks() {
  const dir = await subdir('decks', false);
  if (!dir) return [];
  const names = [];
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === 'file' && name.endsWith('.json')) names.push(name.slice(0, -5));
  }
  return names.sort();
}

export function ensureSubdirs() {
  return Promise.all([subdir('decks', true), subdir('audio', true)]);
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

/* Download as a file — the escape hatch for browsers with no File System
   Access API, and for taking a copy of a deck out of the app. */
export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
