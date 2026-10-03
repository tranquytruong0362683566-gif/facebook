export async function getLocal(key, fallback = null) {
  const data = await new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (value) => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve(value || {});
    });
  });
  return data[key] ?? fallback;
}

export async function setLocal(key, value) {
  await new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve();
    });
  });
}

export async function removeLocal(key) {
  await new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve();
    });
  });
}

export async function clearKnownLocal(keys) {
  await new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve();
    });
  });
}
