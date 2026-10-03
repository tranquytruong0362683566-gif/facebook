(function initializeUtilities(globalScope) {
  "use strict";

  const WINDOWS_RESERVED_NAME =
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const DEFAULT_DOWNLOAD_FOLDER = "TikTok Videos";

  function clampNumber(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  }

  function asText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function hasVideoCaption(input) {
    const rawCaption =
      input && typeof input === "object" ? input.caption : input;
    const caption = asText(rawCaption)
      .normalize("NFKC")
      .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/gu, " ")
      .trim()
      .toLowerCase();

    return Boolean(caption && caption !== "video không có caption");
  }

  function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return 0;
    const normalized = value.replace(/,/g, "").trim();
    const matched = normalized.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!matched) return Number.parseInt(normalized, 10) || 0;
    const multiplier =
      { K: 1e3, M: 1e6, B: 1e9 }[matched[2]?.toUpperCase()] || 1;
    return Math.round(Number.parseFloat(matched[1]) * multiplier) || 0;
  }

  function extractVideoId(videoUrl) {
    const matched = asText(videoUrl).match(/\/video\/(\d+)/);
    return matched?.[1] || "";
  }

  function normalizeUsername(value) {
    const raw = asText(value).replace(/^@/, "");
    if (!raw) return "";
    try {
      return decodeURIComponent(raw).toLowerCase();
    } catch (_) {
      return raw.toLowerCase();
    }
  }

  function parseTikTokVideoUrl(value) {
    try {
      const url = new URL(asText(value));
      const isTikTokHost =
        url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com");
      if (url.protocol !== "https:" || !isTikTokHost) return null;

      const profileVideoMatch = url.pathname.match(
        /^\/@([^/]+)\/video\/(\d+)(?:\/|$)/,
      );
      if (profileVideoMatch) {
        return {
          id: profileVideoMatch[2],
          authorUsername: normalizeUsername(profileVideoMatch[1]),
        };
      }

      const videoMatch = url.pathname.match(/^\/video\/(\d+)(?:\/|$)/);
      if (!videoMatch) return null;
      return { id: videoMatch[1], authorUsername: "" };
    } catch (_) {
      return null;
    }
  }

  function normalizeTikTokInputUrl(value) {
    let candidate = String(value ?? "")
      .trim()
      .replace(/^[\s'"<([{]+/u, "")
      .replace(/[\s'">)\]}.,;!?，。；！？]+$/u, "");
    if (!candidate) return null;
    if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

    try {
      const url = new URL(candidate);
      const hostname = url.hostname.toLowerCase();
      const isTikTokHost =
        hostname === "tiktok.com" || hostname.endsWith(".tiktok.com");
      if (!isTikTokHost || !["http:", "https:"].includes(url.protocol)) {
        return null;
      }

      const profileVideoMatch = url.pathname.match(
        /^\/@([^/]+)\/video\/(\d+)(?:\/|$)/,
      );
      if (profileVideoMatch) {
        return {
          url: `https://www.tiktok.com/@${profileVideoMatch[1]}/video/${profileVideoMatch[2]}`,
          videoId: profileVideoMatch[2],
          type: "video",
        };
      }

      const directVideoMatch = url.pathname.match(/^\/video\/(\d+)(?:\/|$)/);
      if (directVideoMatch) {
        return {
          url: `https://www.tiktok.com/video/${directVideoMatch[1]}`,
          videoId: directVideoMatch[1],
          type: "video",
        };
      }

      const legacyVideoMatch = url.pathname.match(/^\/v\/(\d+)\.html$/);
      if (legacyVideoMatch) {
        return {
          url: `https://www.tiktok.com/video/${legacyVideoMatch[1]}`,
          videoId: legacyVideoMatch[1],
          type: "video",
        };
      }

      const isShortHost =
        hostname === "vt.tiktok.com" || hostname === "vm.tiktok.com";
      const isSharePath = /^\/t\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
      if (!isShortHost && !isSharePath) return null;
      if (!url.pathname || url.pathname === "/") return null;

      const pathname = url.pathname.replace(/\/{2,}/g, "/");
      return {
        url: `https://${hostname}${pathname}`,
        videoId: "",
        type: "short",
      };
    } catch (_) {
      return null;
    }
  }

  function extractTikTokDownloadLinks(value, maximum = 1000) {
    const input = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    const candidates = input.match(
      /(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)*tiktok\.com\/[^\s<>"']+/giu,
    );
    if (!candidates) return [];

    const limit = Math.round(clampNumber(maximum, 1, 5000, 1000));
    const seen = new Set();
    const output = [];
    for (const candidate of candidates) {
      const normalized = normalizeTikTokInputUrl(candidate);
      if (!normalized) continue;
      const key = normalized.videoId
        ? `id:${normalized.videoId}`
        : `url:${normalized.url.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(normalized);
      if (output.length >= limit) break;
    }
    return output;
  }

  function sanitizeCaptionFilename(
    caption,
    fallbackBase = "tiktok-video",
    maxBaseLength = 160,
  ) {
    const safeFallback = asText(fallbackBase) || "tiktok-video";
    let base = asText(caption)
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();

    if (!base) {
      base = safeFallback
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .trim();
    }

    if (WINDOWS_RESERVED_NAME.test(base)) base = `_${base}`;

    let truncated = "";
    for (const character of base) {
      if (truncated.length + character.length > maxBaseLength) break;
      truncated += character;
    }
    base = truncated.replace(/[. ]+$/g, "").trim();
    if (!base) base = "tiktok-video";

    return `${base}.mp4`;
  }

  function sanitizePathSegment(value, maximumLength = 64) {
    let segment = String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[<>:"|?*]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "")
      .trim();

    if (!segment || segment === "." || segment === "..") return "";
    if (WINDOWS_RESERVED_NAME.test(segment)) segment = `_${segment}`;

    let truncated = "";
    for (const character of segment) {
      if (truncated.length + character.length > maximumLength) break;
      truncated += character;
    }
    return truncated.replace(/[. ]+$/g, "").trim();
  }

  function sanitizeDownloadFolder(
    value,
    fallback = DEFAULT_DOWNLOAD_FOLDER,
  ) {
    const sanitize = (input) =>
      String(input ?? "")
        .split(/[\\/]+/)
        .map((segment) => sanitizePathSegment(segment))
        .filter(Boolean)
        .slice(0, 4)
        .join("/");

    return sanitize(value) || sanitize(fallback) || DEFAULT_DOWNLOAD_FOLDER;
  }

  function buildDownloadPath(folder, filename) {
    const safeFolder = sanitizeDownloadFolder(folder);
    const originalFilename = String(filename ?? "").split(/[\\/]+/).pop();
    const extensionMatch = originalFilename?.match(/(\.[A-Za-z0-9]{1,8})$/);
    const extension = extensionMatch?.[1] || ".mp4";
    const base = extensionMatch
      ? originalFilename.slice(0, -extension.length)
      : originalFilename;
    const safeBase = sanitizePathSegment(base, 160) || "tiktok-video";
    return `${safeFolder}/${safeBase}${extension.toLowerCase()}`;
  }

  function normalizeHashtags(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const output = [];
    for (const item of value) {
      const text = asText(item).replace(/^#/, "");
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      output.push(text);
    }
    return output;
  }

  function normalizeVideoRecord(input) {
    if (!input || typeof input !== "object") return null;

    const authorUsername = asText(
      input.authorUsername ||
        input.author_username ||
        input.author?.uniqueId ||
        input.author?.unique_id,
    ).replace(/^@/, "");

    let videoUrl = asText(
      input.videoUrl || input.video_url || input.post_url || input.url,
    );
    const id =
      asText(input.id || input.videoId || input.video_id) ||
      extractVideoId(videoUrl);
    if (!videoUrl && id && authorUsername) {
      videoUrl = `https://www.tiktok.com/@${authorUsername}/video/${id}`;
    }
    if (!id || !videoUrl) return null;

    const rawStats =
      input.stats && typeof input.stats === "object" ? input.stats : {};
    const rawAuthorStats =
      input.authorStats && typeof input.authorStats === "object"
        ? input.authorStats
        : {};
    const caption = asText(
      input.caption || input.desc || input.description || input.content,
    );

    return {
      id,
      videoUrl,
      caption,
      authorUsername,
      authorDisplayName: asText(
        input.authorDisplayName ||
          input.author_display_name ||
          input.author?.nickname,
      ),
      authorAvatar: asText(
        input.authorAvatar || input.author_avatar || input.author?.avatar,
      ),
      authorStats: {
        followers: asNumber(
          rawAuthorStats.followers ?? rawAuthorStats.followerCount,
        ),
        following: asNumber(
          rawAuthorStats.following ?? rawAuthorStats.followingCount,
        ),
        likes: asNumber(rawAuthorStats.likes ?? rawAuthorStats.heartCount),
        videos: asNumber(rawAuthorStats.videos ?? rawAuthorStats.videoCount),
      },
      cover: asText(
        input.cover || input.thumbnail || input.imageUrl || input.image_url,
      ),
      postedAt: asText(input.postedAt || input.posted_at || input.timestamp),
      duration: asNumber(input.duration || input.duration_seconds),
      hashtags: normalizeHashtags(input.hashtags),
      musicName: asText(
        input.musicName || input.music_name || input.music?.title,
      ),
      musicAuthor: asText(
        input.musicAuthor || input.music_author || input.music?.author,
      ),
      width: asNumber(input.width),
      height: asNumber(input.height),
      isPinned: Boolean(input.isPinned || input.is_pinned),
      isAd: Boolean(input.isAd || input.is_ad),
      stats: {
        views: asNumber(rawStats.views ?? input.views ?? input.playCount),
        likes: asNumber(rawStats.likes ?? input.likes ?? input.diggCount),
        comments: asNumber(
          rawStats.comments ?? input.comments ?? input.commentCount,
        ),
        shares: asNumber(rawStats.shares ?? input.shares ?? input.shareCount),
        bookmarks: asNumber(
          rawStats.bookmarks ?? input.bookmarks ?? input.collectCount,
        ),
      },
      scannedAt:
        asText(input.scannedAt || input.scrapedAt || input.scraped_at) ||
        new Date().toISOString(),
    };
  }

  function videoMatchesSource(input, sourceInfo) {
    const video = normalizeVideoRecord(input);
    if (!video || !/^\d{10,25}$/.test(video.id) || video.isAd) return false;

    const parsedUrl = parseTikTokVideoUrl(video.videoUrl);
    if (!parsedUrl || parsedUrl.id !== video.id) return false;

    const recordAuthor = normalizeUsername(video.authorUsername);
    if (
      parsedUrl.authorUsername &&
      recordAuthor &&
      parsedUrl.authorUsername !== recordAuthor
    ) {
      return false;
    }

    const sourceType = asText(sourceInfo?.type).toLowerCase();
    if (sourceType === "video") {
      return video.id === asText(sourceInfo?.id);
    }

    if (sourceType === "profile") {
      const expectedAuthor = normalizeUsername(sourceInfo?.id);
      return Boolean(expectedAuthor && recordAuthor === expectedAuthor);
    }

    return true;
  }

  function preferText(previousValue, nextValue) {
    const previous = asText(previousValue);
    const next = asText(nextValue);
    if (!previous) return next;
    if (!next) return previous;
    return next.length > previous.length ? next : previous;
  }

  function mergeVideoRecords(previous, next) {
    if (!previous) return next;
    if (!next) return previous;

    return {
      ...previous,
      ...next,
      id: previous.id || next.id,
      videoUrl: preferText(previous.videoUrl, next.videoUrl),
      caption: preferText(previous.caption, next.caption),
      authorUsername: preferText(previous.authorUsername, next.authorUsername),
      authorDisplayName: preferText(
        previous.authorDisplayName,
        next.authorDisplayName,
      ),
      authorAvatar: preferText(previous.authorAvatar, next.authorAvatar),
      authorStats: {
        followers: Math.max(
          asNumber(previous.authorStats?.followers),
          asNumber(next.authorStats?.followers),
        ),
        following: Math.max(
          asNumber(previous.authorStats?.following),
          asNumber(next.authorStats?.following),
        ),
        likes: Math.max(
          asNumber(previous.authorStats?.likes),
          asNumber(next.authorStats?.likes),
        ),
        videos: Math.max(
          asNumber(previous.authorStats?.videos),
          asNumber(next.authorStats?.videos),
        ),
      },
      cover: preferText(previous.cover, next.cover),
      postedAt: previous.postedAt || next.postedAt,
      duration: Math.max(asNumber(previous.duration), asNumber(next.duration)),
      hashtags: normalizeHashtags([
        ...(previous.hashtags || []),
        ...(next.hashtags || []),
      ]),
      musicName: preferText(previous.musicName, next.musicName),
      musicAuthor: preferText(previous.musicAuthor, next.musicAuthor),
      width: Math.max(asNumber(previous.width), asNumber(next.width)),
      height: Math.max(asNumber(previous.height), asNumber(next.height)),
      isPinned: Boolean(previous.isPinned || next.isPinned),
      isAd: Boolean(previous.isAd || next.isAd),
      stats: {
        views: Math.max(
          asNumber(previous.stats?.views),
          asNumber(next.stats?.views),
        ),
        likes: Math.max(
          asNumber(previous.stats?.likes),
          asNumber(next.stats?.likes),
        ),
        comments: Math.max(
          asNumber(previous.stats?.comments),
          asNumber(next.stats?.comments),
        ),
        shares: Math.max(
          asNumber(previous.stats?.shares),
          asNumber(next.stats?.shares),
        ),
        bookmarks: Math.max(
          asNumber(previous.stats?.bookmarks),
          asNumber(next.stats?.bookmarks),
        ),
      },
      scannedAt: next.scannedAt || previous.scannedAt,
    };
  }

  const utilities = Object.freeze({
    asNumber,
    asText,
    buildDownloadPath,
    clampNumber,
    DEFAULT_DOWNLOAD_FOLDER,
    extractTikTokDownloadLinks,
    extractVideoId,
    hasVideoCaption,
    mergeVideoRecords,
    normalizeTikTokInputUrl,
    normalizeVideoRecord,
    parseTikTokVideoUrl,
    sanitizeCaptionFilename,
    sanitizeDownloadFolder,
    videoMatchesSource,
  });

  globalScope.TTUtils = utilities;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = utilities;
  }
})(globalThis);
