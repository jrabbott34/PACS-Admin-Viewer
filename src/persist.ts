/**
 * A local library: every ingested DICOM blob (including wrapped JPG/PNG/PDF, which
 * are already DICOM Secondary Capture by the time they reach `register()`) is saved
 * to IndexedDB keyed by SOPInstanceUID, so it's still there after closing the tab.
 * Nothing here ever leaves the browser — same "everything stays in the tab" rule
 * as the rest of the app, just persisted instead of session-only.
 */
const DB_NAME = 'pacs-admin-viewer';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Save (or overwrite) one instance's blob, keyed by SOPInstanceUID. */
export async function saveBlob(sop: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, sop);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Every saved blob, keyed by SOPInstanceUID. */
export async function loadAllBlobs(): Promise<{ sop: string; blob: Blob }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const out: { sop: string; blob: Blob }[] = [];
    const cursorReq = tx.objectStore(STORE).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        out.push({ sop: String(cursor.key), blob: cursor.value as Blob });
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/** Wipe the entire local library. */
export async function clearLibrary(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Best-effort: ask the browser not to evict this data under storage pressure. */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Not supported or denied — the library still works, just not eviction-proof.
  }
}

/** Approximate space used/available, in MB, when the browser can report it. */
export async function estimateUsage(): Promise<{ usageMB: number; quotaMB: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.usage === undefined || est.quota === undefined) return null;
    return { usageMB: est.usage / 1e6, quotaMB: est.quota / 1e6 };
  } catch {
    return null;
  }
}
