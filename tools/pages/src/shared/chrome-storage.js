function runtimeError() {
  return chrome.runtime.lastError?.message || null;
}

export function getLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const message = runtimeError();
      if (message) reject(new Error(message));
      else resolve(result || {});
    });
  });
}

export function setLocal(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const message = runtimeError();
      if (message) reject(new Error(message));
      else resolve();
    });
  });
}

export function removeLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const message = runtimeError();
      if (message) reject(new Error(message));
      else resolve();
    });
  });
}
