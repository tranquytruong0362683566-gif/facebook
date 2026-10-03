const FACEBOOK_ORIGIN = "https://www.facebook.com";

function decodeGraphqlIdentifier(value) {
  const raw = String(value || "").trim();
  if (raw.length < 12 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const decoded = atob(padded);
    return decoded && /^[\x20-\x7e]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function facebookPostIdFromIdentifier(value, allowDecode = true) {
  const raw = String(value || "").replace(/\\\//g, "/").trim();
  if (!raw) return null;

  const routeId = raw.match(/\/(?:posts|permalink|pending_posts|videos)\/(pfbid[A-Za-z0-9]+|\d+)/i)?.[1];
  if (routeId) return routeId;

  const queryId = raw.match(/[?&](?:story_fbid|fbid|v)=(pfbid[A-Za-z0-9]+|\d+)/i)?.[1];
  if (queryId) return queryId;

  const pfbid = raw.match(/(pfbid[A-Za-z0-9]+)/i)?.[1];
  if (pfbid) return pfbid;
  if (/^\d+$/.test(raw)) return raw;

  if (allowDecode) {
    const decoded = decodeGraphqlIdentifier(raw);
    if (decoded && decoded !== raw) {
      const decodedId = facebookPostIdFromIdentifier(decoded, false);
      if (decodedId) return decodedId;
    }
  }

  const segments = raw.split(/[:_]/).filter((segment) => /^\d+$/.test(segment));
  return segments.at(-1) || null;
}

export function exactFacebookPostUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.replace(/\\\//g, "/").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw, FACEBOOK_ORIGIN);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/i.test(parsed.hostname) || parsed.protocol !== "https:") return null;

  const exactRoute = /\/(?:posts|permalink|pending_posts|videos)\/(?:pfbid[A-Za-z0-9]+|\d+)(?:\/|$)/i
    .test(parsed.pathname);
  const queryId = parsed.searchParams.get("story_fbid")
    || parsed.searchParams.get("fbid")
    || parsed.searchParams.get("v")
    || "";
  const exactQueryRoute = /\/(?:permalink|story|photo)\.php$/i.test(parsed.pathname)
    || /\/(?:photo|watch)\/?$/i.test(parsed.pathname);
  return exactRoute || (exactQueryRoute && /^(?:pfbid[A-Za-z0-9]+|\d+)$/.test(queryId))
    ? parsed.href
    : null;
}

export function facebookGroupIdFromPostUrl(value) {
  const url = exactFacebookPostUrl(value);
  if (!url) return null;
  try {
    return new URL(url).pathname.match(/^\/groups\/(\d+)\/(?:posts|permalink|pending_posts|videos)\//i)?.[1] || null;
  } catch {
    return null;
  }
}

export function facebookGroupScopedPostUrl(groupId, value, fallbackPostId = null) {
  const normalizedGroupId = String(groupId || "").trim();
  if (!/^\d+$/.test(normalizedGroupId)) return null;
  const direct = exactFacebookPostUrl(value);
  if (direct && facebookGroupIdFromPostUrl(direct) === normalizedGroupId) return direct;
  const postId = facebookPostIdFromIdentifier(fallbackPostId)
    || facebookPostIdFromIdentifier(direct);
  if (!postId) return null;
  return exactFacebookPostUrl(
    `${FACEBOOK_ORIGIN}/groups/${encodeURIComponent(normalizedGroupId)}/posts/${encodeURIComponent(postId)}`
  );
}

function findExactFacebookPostUrl(value, seen = new WeakSet()) {
  const direct = exactFacebookPostUrl(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findExactFacebookPostUrl(child, seen);
    if (found) return found;
  }
  return null;
}

function collectPostIdentifiers(value, output = [], seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  const acceptedKeys = /^(?:post_id|story_id|legacy_story_id|legacy_story_hideable_id|top_level_post_id|mf_story_key)$/i;
  for (const [key, child] of Object.entries(value)) {
    if (acceptedKeys.test(key) && (typeof child === "string" || typeof child === "number")) {
      output.push(String(child));
    }
    if (child && typeof child === "object") collectPostIdentifiers(child, output, seen);
  }
  return output;
}

export function resolveFacebookStoryLink(groupId, storyCreate, fallbackUrl = null) {
  const directCandidates = [
    storyCreate?.story?.permalink_url,
    storyCreate?.story?.url,
    storyCreate?.permalink_url,
    storyCreate?.url,
    storyCreate?.feed_story_edge?.node?.permalink_url,
    storyCreate?.feed_story_edge?.node?.url
  ];
  const directUrl = directCandidates.map(exactFacebookPostUrl).find(Boolean) || null;
  const storyId = String(storyCreate?.story_id || storyCreate?.story?.id || "") || null;
  const identifiers = [
    storyCreate?.post_id,
    storyCreate?.story_id,
    storyCreate?.story?.post_id,
    storyCreate?.story?.legacy_story_hideable_id,
    storyCreate?.story?.legacy_story_id,
    storyCreate?.story?.id,
    storyCreate?.feed_story_edge?.node?.post_id,
    storyCreate?.feed_story_edge?.node?.legacy_story_hideable_id,
    storyCreate?.feed_story_edge?.node?.id,
    ...collectPostIdentifiers(storyCreate)
  ];
  const postId = identifiers
    .map((identifier) => facebookPostIdFromIdentifier(identifier))
    .find(Boolean) || null;
  const generatedUrl = postId
    ? `${FACEBOOK_ORIGIN}/groups/${encodeURIComponent(String(groupId))}/posts/${encodeURIComponent(postId)}`
    : null;
  const nestedUrl = directUrl || generatedUrl ? null : findExactFacebookPostUrl(storyCreate);
  const url = directUrl || generatedUrl || nestedUrl || exactFacebookPostUrl(fallbackUrl);
  return { url: url || null, storyId, postId };
}
