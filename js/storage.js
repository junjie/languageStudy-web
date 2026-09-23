/* Where the app keeps its state.

   There is no server and no database. Everything the app remembers lives in
   one directory, laid out the same way whichever directory that turns out to
   be:

     settings.json        models, limits, voices, language, prompts
     decks/<slug>.json    one deck per file
     audio/manifest.json  the dictation bank index
     audio/quota.json     the rolling API call budget
     audio/<id>.wav|.txt  generated speech and its transcript

   Two kinds of directory can hold that layout, and the browser decides which:

     'folder'    a folder on disk the user picked — see fs-folder.js
     'browser'   the origin private file system — see fs-opfs.js

   A folder is the better store in every way that matters, so this is a
   fallback and not a preference: where the picker exists the app never reaches
   for browser storage, and where it does not the app never offers a folder.
   One store is live at a time, which is why there is nothing here that moves
   data between them — no browser offers both.

   Both kinds are FileSystemDirectoryHandles, so every file operation below is
   the same code either way. The backend modules differ only in how the root
   handle is got and what may be assumed about keeping it.

   The API key is the one thing that never goes in here — it stays in
   localStorage, so pointing the app at a folder that happens to be a git clone
   cannot leak it. */

import * as folder from './fs-folder.js';
import * as opfs from './fs-opfs.js';

const KEY_STORAGE = 'lsw.apiKey';

export const SUPPORTS_FOLDER = folder.SUPPORTED;
export const SUPPORTS_BROWSER = opfs.SUPPORTED;

/* ── the live store ──────────────────────────────────────────────────── */

let root = null;
let kind = null;
let rootName = '';
let persisted = false;
const listeners = new Set();

export function onStoreChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) {
    try { fn(kind); } catch (e) { console.error(e); }
  }
}

export function isConnected() {
  return !!root;
}

/* 'folder', 'browser', or null when nothing is being saved. */
export function backend() {
  return kind;
}

/* What to call the place, for the line of UI that says where saving goes. */
export function label() {
  if (kind === 'folder') return rootName;
  if (kind === 'browser') return 'this browser';
  return null;
}

/* Only meaningful for browser storage: whether it is exempt from eviction. */
export function isPersisted() {
  return kind !== 'browser' || persisted;
}

async function adopt(k, handle) {
  root = handle;
  kind = k;
  rootName = handle.name || '';
  persisted = k === 'browser' ? await opfs.requestPersistence() : true;
  announce();
}

function release() {
  root = null;
  kind = null;
  rootName = '';
  persisted = false;
}

/* Must be called from a click. */
export async function connect() {
  await adopt('folder', await folder.pick());
  return label();
}

/* Called once at boot. Never prompts for a folder — a prompt without a click
   is refused by the browser, and would be rude anyway — and adopts browser
   storage only where there is no folder to prompt for. */
export async function restore() {
  if (folder.SUPPORTED) {
    const saved = await folder.remembered();
    if (saved && saved.permission === 'granted') {
      await adopt('folder', saved.handle);
      return { state: 'folder', name: label() };
    }
    if (saved) return { state: 'needs-permission', name: saved.handle.name, handle: saved.handle };
    return { state: 'none' };
  }
  if (opfs.SUPPORTED) {
    try {
      await adopt('browser', await opfs.root());
      return { state: 'browser', persisted };
    } catch (e) {
      console.error('Browser storage is there but would not open', e);
      release();
    }
  }
  return { state: 'unsupported' };
}

/* Must be called from a click. */
export async function regrant(handle) {
  if (!(await folder.regrant(handle))) return false;
  await adopt('folder', handle);
  return true;
}

export async function disconnect() {
  release();
  await folder.forget();
  announce();
}

/* A folder write failing usually means the handle went stale — the folder was
   moved, renamed, or its permission revoked. Drop it so the UI asks for a
   fresh one instead of silently losing every later write too.

   Browser storage cannot go stale that way: a failure there is the disk or the
   quota, everything already written is still readable, and there is no other
   store to fall back to — so the root is worth keeping. */
async function invalidate(err) {
  console.error('Write failed', err);
  if (kind !== 'folder') return;
  release();
  await folder.forget();
  announce();
}

async function subdir(name, create) {
  if (!root) return null;
  try {
    return await root.getDirectoryHandle(name, { create });
  } catch (e) {
    return null;
  }
}

/* ── files ───────────────────────────────────────────────────────────── */

async function resolve(path, { create = false } = {}) {
  if (!root) return null;
  const parts = path.split('/');
  const file = parts.pop();
  let dir = root;
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
  let dir = root;
  for (const part of parts) {
    if (!dir) return false;
    dir = await dir.getDirectoryHandle(part).catch(() => null);
  }
  if (!dir) return false;
  return dir.removeEntry(file).then(() => true, () => false);
}

/* entries() is the natural way to walk a directory, but the browsers that only
   have browser storage were also the slowest to the async iterators, so fall
   back to values() where entries() is missing. */
async function* handlesIn(dir) {
  if (typeof dir.entries === 'function') {
    for await (const [, entry] of dir.entries()) yield entry;
  } else if (typeof dir.values === 'function') {
    for await (const entry of dir.values()) yield entry;
  }
}

export async function listDecks() {
  const dir = await subdir('decks', false);
  if (!dir) return [];
  const names = [];
  for await (const entry of handlesIn(dir)) {
    if (entry.kind === 'file' && entry.name.endsWith('.json')) names.push(entry.name.slice(0, -5));
  }
  return names.sort();
}

export function ensureSubdirs() {
  return Promise.all([subdir('decks', true), subdir('audio', true)]);
}

/* ── the API key: localStorage only, never the store ─────────────────── */

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (e) { /* private mode; the key just will not be remembered */ }
}

/* ── small values that must work with nothing connected ──────────────── */

export function localGet(key, fallback) {
  try {
    const raw = localStorage.getItem('lsw.' + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}

export function localSet(key, value) {
  try { localStorage.setItem('lsw.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

/* Download as a file — the escape hatch for a browser that can save nothing,
   and for taking a copy of a deck out of the app. */
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
