(() => {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    SESSION: "fbrs.scanSession",
    QUEUE: "fbrs.downloadQueue",
    SETTINGS: "fbrs.settings"
  });

  const DEFAULT_SETTINGS = Object.freeze({
    maxItems: 500,
    maxScrolls: 180,
    idleRounds: 9,
    scrollDelayMs: 1100,
    resolveDelayMs: 350,
    autoOpenResults: true,
    restoreScroll: true,
    downloadFolder: "Facebook Reels",
    minVideoHeight: 0
  });

  function isFacebookHost(hostname) {
    const host = String(hostname || "").toLowerCase().split(":")[0];
    return host === "facebook.com" || host.endsWith(".facebook.com");
  }

  function isFacebookUrl(value) {
    try {
      return isFacebookHost(new URL(String(value)).hostname);
    } catch {
      return false;
    }
  }

  function normalizeIdentityName(value) {
    return cleanText(value, 200)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("vi")
      .replace(/\b(?:facebook|reels?|official)\b/gi, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function ownerNamesMatch(left, right) {
    const a = normalizeIdentityName(left);
    const b = normalizeIdentityName(right);
    if (!a || !b) return false;
    return a === b || (a.replace(/\s/g, "") === b.replace(/\s/g, "") && Math.min(a.length, b.length) >= 4);
  }

  function getReelId(value) {
    try {
      const url = new URL(String(value), "https://www.facebook.com");
      if (!isFacebookHost(url.hostname)) return "";

      const match = url.pathname.match(/\/(?:reel|reels|videos)\/(\d{5,})(?:\/|$)/i);
      if (match) return match[1];

      const videoId = url.searchParams.get("v") || url.searchParams.get("video_id");
      return /^\d{5,}$/.test(videoId || "") ? videoId : "";
    } catch {
      return "";
    }
  }

  function normalizeReelUrl(value) {
    const id = getReelId(value);
    return id ? `https://www.facebook.com/reel/${id}` : "";
  }

  function normalizeFacebookDownloadUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || url.username || url.password) return "";
      const canonical = normalizeReelUrl(url.href);
      if (canonical) return canonical;

      const pathname = url.pathname.replace(/\/{2,}/g, "/");
      if (host === "fb.watch") {
        if (!/^\/[A-Za-z0-9._-]+\/?$/.test(pathname)) return "";
        return `https://fb.watch/${pathname.split("/").filter(Boolean)[0]}/`;
      }

      if (!isFacebookHost(host)) return "";
      const shareMatch = pathname.match(/^\/share\/(r|v)\/([A-Za-z0-9._-]+)\/?$/i);
      if (!shareMatch) return "";
      return `https://www.facebook.com/share/${shareMatch[1].toLowerCase()}/${shareMatch[2]}/`;
    } catch {
      return "";
    }
  }

  function extractFacebookDownloadLinks(value, maximum = 1000) {
    const input = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    const candidates = input.match(
      /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:(?:[A-Za-z0-9-]+\.)*facebook\.com|fb\.watch)\/[^\s<>"']+/giu
    );
    if (!candidates) return [];

    const limit = Math.min(5000, Math.max(1, Math.round(Number(maximum) || 1000)));
    const seen = new Set();
    const output = [];
    for (const candidate of candidates) {
      const cleaned = candidate.replace(/[),.;\]}]+$/g, "");
      const url = normalizeFacebookDownloadUrl(cleaned);
      if (!url) continue;
      const reelId = getReelId(url);
      const key = reelId ? `id:${reelId}` : `url:${url.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        url,
        reelId,
        type: reelId ? "reel" : url.includes("/share/") ? "share" : "short"
      });
      if (output.length >= limit) break;
    }
    return output;
  }

  function cleanText(value, maxLength = 500) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function looksGenericTitle(value) {
    const text = cleanText(value, 300).toLowerCase();
    if (!text) return true;
    return [
      "facebook",
      "facebook reels",
      "reels",
      "watch",
      "video",
      "log in or sign up to view",
      "đăng nhập hoặc đăng ký"
    ].includes(text);
  }

  function sanitizeFilename(value, fallback = "Facebook Reel", maxLength = 150) {
    let name = cleanText(value, 500)
      .normalize("NFC")
      .replace(/[<>:"/\\|?*]/g, " ")
      .replace(/[. ]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name) name = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      name = `_${name}`;
    }

    const chars = Array.from(name);
    if (chars.length > maxLength) {
      name = chars.slice(0, maxLength).join("").replace(/[. ]+$/g, "");
    }
    return name || fallback;
  }

  function sanitizeFolder(value) {
    return sanitizeFilename(value, "Facebook Reels", 60)
      .replace(/\.{2,}/g, ".")
      .replace(/^\.+$/g, "Facebook Reels");
  }

  function formatDateTime(value) {
    if (!value) return "—";
    try {
      return new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "short",
        timeStyle: "medium"
      }).format(new Date(value));
    } catch {
      return String(value);
    }
  }

  function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return "";
    const mins = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function qualityLabel(item) {
    const qualityHeight = Number(item?.qualityHeight || 0);
    const audioLabel = item?.hasAudio === true ? " + audio" : item?.hasAudio === false ? " · không audio" : "";
    if (qualityHeight) return `${qualityHeight}p${audioLabel}`;
    const width = Number(item?.width || 0);
    const height = Number(item?.height || 0);
    if (width && height) return `${Math.min(width, height)}p${audioLabel}`;
    if (height) return `${height}p${audioLabel}`;
    return cleanText(item?.quality || "", 50) || "Chờ FSave chất lượng cao nhất";
  }

  function newId(prefix = "id") {
    const random = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function storageSet(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function mergeSettings(value) {
    const candidate = value && typeof value === "object" ? value : {};
    return {
      maxItems: Math.min(1000, Math.max(1, Number(candidate.maxItems || DEFAULT_SETTINGS.maxItems))),
      maxScrolls: Math.min(500, Math.max(1, Number(candidate.maxScrolls || DEFAULT_SETTINGS.maxScrolls))),
      idleRounds: Math.min(30, Math.max(2, Number(candidate.idleRounds || DEFAULT_SETTINGS.idleRounds))),
      scrollDelayMs: Math.min(5000, Math.max(500, Number(candidate.scrollDelayMs || DEFAULT_SETTINGS.scrollDelayMs))),
      resolveDelayMs: Math.min(5000, Math.max(0, Number(candidate.resolveDelayMs ?? DEFAULT_SETTINGS.resolveDelayMs))),
      autoOpenResults: candidate.autoOpenResults === undefined
        ? DEFAULT_SETTINGS.autoOpenResults
        : Boolean(candidate.autoOpenResults),
      restoreScroll: candidate.restoreScroll === undefined
        ? DEFAULT_SETTINGS.restoreScroll
        : Boolean(candidate.restoreScroll),
      downloadFolder: sanitizeFolder(candidate.downloadFolder || DEFAULT_SETTINGS.downloadFolder),
      minVideoHeight: 0
    };
  }

  function sessionItems(session) {
    return Object.values(session?.items || {}).filter((item) => !item?.excluded).sort((a, b) => {
      const ai = Number(a?.order ?? Number.MAX_SAFE_INTEGER);
      const bi = Number(b?.order ?? Number.MAX_SAFE_INTEGER);
      return ai - bi;
    });
  }

  const api = Object.freeze({
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    isFacebookHost,
    isFacebookUrl,
    getReelId,
    normalizeReelUrl,
    normalizeFacebookDownloadUrl,
    extractFacebookDownloadLinks,
    cleanText,
    looksGenericTitle,
    normalizeIdentityName,
    ownerNamesMatch,
    sanitizeFilename,
    sanitizeFolder,
    formatDateTime,
    formatDuration,
    qualityLabel,
    newId,
    delay,
    storageGet,
    storageSet,
    storageRemove,
    mergeSettings,
    sessionItems
  });

  globalThis.ReelKit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
