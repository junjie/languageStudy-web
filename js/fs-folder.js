/* A folder on disk, picked by the user.

   This is the File System Access API, so Chromium only. It gives the best
   version of what the app wants: files the user can see in a file manager,
   diff, copy to a backup drive, or keep inside a Drive or Dropbox folder and
   get sync for free.

   A directory handle survives a reload but its permission does not always, and
   requestPermission() is only allowed from a user gesture. So remembered()
   reports what it found without prompting, and the UI turns a lapsed
   permission into a button the user clicks.

   The handle lives in IndexedDB because handles are structured-cloneable and
   localStorage only holds strings. */

const DB_NAME = 'language-study-web';
const STORE = 'handles';
const HANDLE_KEY = 'dataDirHandle';

export const SUPPORTED = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

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

/* Must be called from a click. Throws AbortError if the user cancels. */
export async function pick() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'language-study-data' });
  await idbPut(HANDLE_KEY, handle).catch(() => {});
  return handle;
}

/* Never prompts — a prompt without a click is refused by the browser, and
   would be rude anyway. */
export async function remembered() {
  if (!SUPPORTED) return null;
  let handle = null;
  try { handle = await idbGet(HANDLE_KEY); } catch (e) { handle = null; }
  if (!handle) return null;
  let permission = 'prompt';
  try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { permission = 'prompt'; }
  return { handle, permission };
}

/* Must be called from a click. */
export function regrant(handle) {
  return handle.requestPermission({ mode: 'readwrite' }).then((p) => p === 'granted', () => false);
}

export function forget() {
  return idbDel(HANDLE_KEY).catch(() => {});
}
