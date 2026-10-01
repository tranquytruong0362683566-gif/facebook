(function (root) {
  'use strict';
  const FORMAT = 'tqt-auto-comment-backup';
  const MAX_BYTES = 20 * 1024 * 1024;
  const secretKey = key => /api_keys?|apify_tokens?|facebook_cookies|cookie_lines/i.test(key);
  const permittedKey = key => /^truong_[a-z0-9_]+$/.test(key);

  function createBackup(storage, includeSecrets = false) {
    const items = Object.create(null);
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!permittedKey(key) || (!includeSecrets && secretKey(key))) continue;
      items[key] = storage.getItem(key);
    }
    return { format: FORMAT, version: 1, createdAt: new Date().toISOString(), includeSecrets, items };
  }

  function parseBackup(text) {
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('File dữ liệu vượt quá 20 MB.');
    const backup = JSON.parse(text);
    if (backup?.format !== FORMAT || backup.version !== 1 || !backup.items
        || typeof backup.items !== 'object' || Array.isArray(backup.items)) {
      throw new Error('File không phải bản sao dữ liệu Facebook Auto Comment.');
    }
    const items = Object.create(null);
    for (const [key, value] of Object.entries(backup.items)) {
      if (!permittedKey(key) || typeof value !== 'string') throw new Error('File chứa dữ liệu không hợp lệ.');
      JSON.parse(value); // Every application value is JSON stored as a string.
      items[key] = value;
    }
    return items;
  }

  function restoreBackup(storage, items) {
    const before = new Map(Object.keys(items).map(key => [key, storage.getItem(key)]));
    try { for (const [key, value] of Object.entries(items)) storage.setItem(key, value); }
    catch (error) {
      for (const [key, value] of before) {
        try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch {}
      }
      throw new Error(`Không đủ dung lượng lưu dữ liệu: ${error.message}`);
    }
    return Object.keys(items).length;
  }

  function downloadBackup(storage, includeSecrets = false) {
    const backup = createBackup(storage, includeSecrets);
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `auto-comment-data-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return Object.keys(backup.items).length;
  }

  root.TqtDashboardBackup = Object.freeze({ MAX_BYTES, createBackup, parseBackup, restoreBackup, downloadBackup });
}(globalThis));
