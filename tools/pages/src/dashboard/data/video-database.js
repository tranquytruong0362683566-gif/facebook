const DB_NAME = "FacebookPageVideoPoster";
const DB_VERSION = 1;
const STORE_NAME = "videos";

let databasePromise = null;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request thất bại."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction thất bại."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction bị hủy."));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error("Không mở được IndexedDB."));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("IndexedDB đang bị một tab cũ khóa."));
    };
  });
  return databasePromise;
}

export async function putVideo(id, file) {
  if (!(file instanceof File)) throw new TypeError("Dữ liệu video không phải File.");
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put({
    id,
    file,
    updatedAt: Date.now()
  });
  await transactionDone(transaction);
}

export async function getVideo(id) {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const done = transactionDone(transaction);
  const record = await requestResult(transaction.objectStore(STORE_NAME).get(id));
  await done;
  return record?.file instanceof File ? record.file : null;
}

export async function listVideoIds() {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const done = transactionDone(transaction);
  const ids = await requestResult(transaction.objectStore(STORE_NAME).getAllKeys());
  await done;
  return ids.map(String);
}

export async function clearVideos() {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
}

export async function pruneVideos(validIds) {
  const keep = new Set(validIds || []);
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const request = store.openKeyCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (!keep.has(cursor.primaryKey)) store.delete(cursor.primaryKey);
    cursor.continue();
  };
  await transactionDone(transaction);
}
