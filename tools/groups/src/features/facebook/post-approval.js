import { isPendingApprovalStory } from "../../shared/utils.js";
import { facebookPostIdFromIdentifier } from "./post-links.js";

const COMMENT_ALLOWED_KEYS = new Set([
  "can_viewer_comment",
  "viewer_can_comment",
  "can_comment",
  "can_user_comment",
  "is_commenting_enabled",
  "commenting_enabled",
  "comments_enabled"
]);
const COMMENT_BLOCKED_KEYS = new Set([
  "is_commenting_disabled",
  "commenting_disabled",
  "comments_disabled",
  "is_comments_disabled",
  "viewer_cannot_comment",
  "is_comment_locked"
]);
const PENDING_KEYS = new Set([
  "is_pending",
  "is_pending_post",
  "pending_approval",
  "is_awaiting_approval",
  "is_marked_as_spam",
  "is_spam"
]);
const PENDING_STATUS = /^(?:PENDING|PENDING_APPROVAL|AWAITING_APPROVAL|IN_REVIEW|SPAM|MARKED_AS_SPAM)$/i;
const COMMENT_BUTTON_PATTERN = /(?:aria-label|title|accessibility_label|accessibilityLabel)\s*(?:=|:)\s*["'](?:Bình luận|Viết bình luận|Comment|Write a comment)(?:[^"']*)["']/i;
const INTERACTION_BUTTON_PATTERN = /(?:aria-label|title)\s*=\s*["'](?:Thích|Bày tỏ cảm xúc|Chia sẻ|Like|React|Share)(?:[^"']*)["']/i;
const PENDING_TEXT_PATTERN = /(?:bài viết|bài đăng)[^.\n<]{0,100}(?:chờ(?:\s+quản trị viên)?\s+(?:duyệt|phê duyệt)|chưa\s+(?:được\s+)?(?:duyệt|phê duyệt)|bị\s+(?:đánh dấu|gắn cờ)\s+spam)|pending\s+(?:admin\s+)?approval|awaiting\s+(?:admin\s+)?approval|marked\s+as\s+spam/i;

function asBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function inspectDirectObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const [key, candidate] of Object.entries(value)) {
    const flag = asBoolean(candidate);
    if (flag === null) continue;
    if (COMMENT_ALLOWED_KEYS.has(key)) return { canComment: flag, source: `graphql:${key}` };
    if (COMMENT_BLOCKED_KEYS.has(key)) return { canComment: !flag, source: `graphql:${key}` };
  }

  const reason = value.comment_disabled_reason
    || value.commenting_disabled_reason
    || value.viewer_cannot_comment_reason;
  if (typeof reason === "string" && reason.trim()) {
    return { canComment: false, source: "graphql:comment_disabled_reason" };
  }
  return null;
}

function scanObjectSignals(root) {
  if (!root || typeof root !== "object") return { pendingApproval: false, permission: null };
  const preferred = [
    root?.story?.feedback,
    root?.feedback,
    root?.feed_story_edge?.node?.feedback,
    root?.story,
    root
  ];
  for (const candidate of preferred) {
    const permission = inspectDirectObject(candidate);
    if (permission) {
      return {
        pendingApproval: isPendingApprovalStory(root),
        permission
      };
    }
  }

  let pendingApproval = isPendingApprovalStory(root);
  const seen = new WeakSet();
  const queue = [root];
  let inspected = 0;
  while (queue.length > 0 && inspected < 1200) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    inspected += 1;

    const permission = inspectDirectObject(current);
    if (permission) return { pendingApproval, permission };
    for (const [key, candidate] of Object.entries(current)) {
      const flag = asBoolean(candidate);
      if (PENDING_KEYS.has(key) && flag === true) pendingApproval = true;
      if (/^(?:status|moderation_status|publishing_status|review_status|spam_status)$/i.test(key)
        && PENDING_STATUS.test(String(candidate || ""))) {
        pendingApproval = true;
      }
      if (candidate && typeof candidate === "object") queue.push(candidate);
    }
  }
  return { pendingApproval, permission: null };
}

function normalizeMarkup(value) {
  return String(value || "")
    .replace(/\\u0022/gi, '"')
    .replace(/\\"/g, '"')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/\\\//g, "/");
}

function signalDistance(index, anchorPositions) {
  if (anchorPositions.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...anchorPositions.map((anchor) => Math.abs(anchor - index)));
}

function selectMarkupPermission(markup, postId) {
  const keyNames = [...COMMENT_ALLOWED_KEYS, ...COMMENT_BLOCKED_KEYS].join("|");
  const expression = new RegExp(`["'](${keyNames})["']\\s*:\\s*(true|false|0|1)`, "gi");
  const anchors = [];
  const normalizedPostId = facebookPostIdFromIdentifier(postId);
  if (normalizedPostId) {
    let index = markup.indexOf(normalizedPostId);
    while (index >= 0 && anchors.length < 40) {
      anchors.push(index);
      index = markup.indexOf(normalizedPostId, index + normalizedPostId.length);
    }
  }

  const signals = [];
  for (const match of markup.matchAll(expression)) {
    const key = match[1].toLowerCase();
    const rawFlag = asBoolean(match[2]);
    if (rawFlag === null) continue;
    signals.push({
      canComment: COMMENT_BLOCKED_KEYS.has(key) ? !rawFlag : rawFlag,
      distance: signalDistance(match.index || 0, anchors),
      source: `page:${key}`
    });
  }
  if (signals.length === 0) return null;

  if (anchors.length > 0) {
    signals.sort((left, right) => left.distance - right.distance);
    const nearest = signals[0];
    const equallyClose = signals.filter((signal) => signal.distance <= nearest.distance + 240);
    if (equallyClose.every((signal) => signal.canComment === nearest.canComment)) return nearest;
    return null;
  }

  return signals.every((signal) => signal.canComment === signals[0].canComment)
    ? signals[0]
    : null;
}

export function inspectFacebookPostMarkup(markup, { postId = null } = {}) {
  const source = normalizeMarkup(markup);
  if (!source.trim()) return { pendingApproval: false, canComment: null, source: "page:empty" };

  const pendingByFlag = /["'](?:is_pending|is_pending_post|pending_approval|is_awaiting_approval|is_marked_as_spam|is_spam)["']\s*:\s*(?:true|1)/i.test(source)
    || /["'](?:moderation_status|publishing_status|review_status|spam_status)["']\s*:\s*["'](?:PENDING|PENDING_APPROVAL|AWAITING_APPROVAL|IN_REVIEW|SPAM|MARKED_AS_SPAM)["']/i.test(source)
    || PENDING_TEXT_PATTERN.test(source);
  if (pendingByFlag) {
    return { pendingApproval: true, canComment: false, source: "page:pending_approval" };
  }

  const permission = selectMarkupPermission(source, postId);
  if (permission) {
    return {
      pendingApproval: permission.canComment === false,
      canComment: permission.canComment,
      source: permission.source
    };
  }
  if (COMMENT_BUTTON_PATTERN.test(source)) {
    return { pendingApproval: false, canComment: true, source: "page:comment_button" };
  }
  const normalizedPostId = facebookPostIdFromIdentifier(postId);
  if (normalizedPostId && source.includes(normalizedPostId) && INTERACTION_BUTTON_PATTERN.test(source)) {
    return { pendingApproval: true, canComment: false, source: "page:comment_button_missing" };
  }
  return { pendingApproval: false, canComment: null, source: "page:unknown" };
}

export function inspectFacebookPostApproval({
  storyCreate = null,
  url = "",
  markup = null,
  postId = null,
  pendingApproval = false
} = {}) {
  const graphSignals = scanObjectSignals(storyCreate);
  const knownPending = Boolean(pendingApproval)
    || isPendingApprovalStory(storyCreate, url)
    || graphSignals.pendingApproval;

  if (knownPending) {
    return {
      pendingApproval: true,
      canComment: false,
      verified: true,
      source: "graphql:pending_approval"
    };
  }
  if (graphSignals.permission) {
    return {
      pendingApproval: graphSignals.permission.canComment === false,
      canComment: graphSignals.permission.canComment,
      verified: true,
      source: graphSignals.permission.source
    };
  }
  if (markup !== null && markup !== undefined) {
    const page = inspectFacebookPostMarkup(markup, { postId });
    return {
      pendingApproval: page.pendingApproval,
      canComment: page.canComment,
      verified: typeof page.canComment === "boolean",
      source: page.source
    };
  }
  return { pendingApproval: false, canComment: null, verified: false, source: "unknown" };
}
