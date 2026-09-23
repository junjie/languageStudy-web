/* Browser storage: the origin private file system.

   navigator.storage.getDirectory() hands back a directory with exactly the
   FileSystemDirectoryHandle interface a picked folder has, so nothing above
   this file can tell the two apart. What differs is whose files they are:
   these belong to the origin rather than to the user. No file manager shows
   them, and clearing site data for the page deletes them.

   Firefox and Safari have this and have no folder picker, so this is what
   "your data is saved" means there.

   Writing needs FileSystemWritableFileStream, which arrived later than the
   directory itself — the first Safari to ship the origin private file system
   could only write through createSyncAccessHandle() inside a Worker. Rather
   than carry a worker for those versions, SUPPORTED reports false when
   createWritable is missing and the app says it cannot save. That is the
   truth, and better than a store that accepts every write and keeps none. */

export const SUPPORTED =
  typeof navigator !== 'undefined' &&
  !!navigator.storage &&
  typeof navigator.storage.getDirectory === 'function' &&
  typeof FileSystemFileHandle !== 'undefined' &&
  typeof FileSystemFileHandle.prototype.createWritable === 'function';

export function root() {
  return navigator.storage.getDirectory();
}

/* Origin storage is evictable: browsers clear it under disk pressure, and
   Safari drops script-writable storage for a site left unopened for weeks.
   persist() asks to be exempt. It can be refused, and the answer is worth
   knowing rather than hiding, because it is the difference between "saved"
   and "saved unless the browser needs the space". */
export async function requestPersistence() {
  try {
    if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) return true;
    if (typeof navigator.storage.persist !== 'function') return false;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}
