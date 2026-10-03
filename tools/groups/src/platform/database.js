const DB_NAME = "facebook-group-poster-vi";
const DB_VERSION = 1;

export const STORE = Object.freeze({
  GROUP_LISTS: "groupLists",
  CAMPAIGNS: "campaigns",
  ASSETS: "assets"
});

let databasePromise = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of Object.values(STORE)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "key" });
        }
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("Không mở được cơ sở dữ liệu cục bộ."));
    request.onblocked = () => reject(new Error("Cơ sở dữ liệu đang bị một thẻ khác khóa."));
  });
  databasePromise = databasePromise.catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Thao tác cơ sở dữ liệu thất bại."));
  });
}

export async function dbPut(storeName, key, value) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  const request = transaction.objectStore(storeName).put({
    key,
    value,
    updatedAt: Date.now()
  });
  await requestToPromise(request);
  return value;
}

export async function dbGet(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  const row = await requestToPromise(transaction.objectStore(storeName).get(key));
  return row?.value ?? null;
}

export async function dbDelete(storeName, key) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  await requestToPromise(transaction.objectStore(storeName).delete(key));
}

export async function dbList(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readonly");
  const rows = await requestToPromise(transaction.objectStore(storeName).getAll());
  return rows
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updatedAt }));
}

export async function dbClear(storeName) {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, "readwrite");
  await requestToPromise(transaction.objectStore(storeName).clear());
}
