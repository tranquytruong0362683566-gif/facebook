import { NATIVE_GROUP_LIMIT } from "../../shared/constants.js";
import {
  exactFacebookPostUrl,
  facebookGroupScopedPostUrl,
  facebookPostIdFromIdentifier
} from "../facebook/post-links.js";

const POSTED_STATUS = Object.freeze({
  PUBLISHED: "published",
  PENDING: "pending"
});

function resultTime(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function resolvePostedGroupUrl(groupId, record = {}) {
  const normalizedGroupId = String(groupId || "").trim();
  if (!/^\d+$/.test(normalizedGroupId)) return null;

  const urlCollections = [record.resultUrls, record.groupUrls, record.postUrls];
  for (const collection of urlCollections) {
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) continue;
    const direct = facebookGroupScopedPostUrl(normalizedGroupId, collection[normalizedGroupId]);
    if (direct) return direct;
  }

  const explicitPostId = [record.postId, record.post_id, record.storyId, record.story_id]
    .map((value) => facebookPostIdFromIdentifier(value))
    .find(Boolean) || null;
  for (const candidate of [record.url, record.resultUrl, record.permalink, record.permalinkUrl]) {
    const direct = facebookGroupScopedPostUrl(normalizedGroupId, candidate, explicitPostId);
    if (direct) return direct;
  }

  return explicitPostId
    ? exactFacebookPostUrl(`https://www.facebook.com/groups/${normalizedGroupId}/posts/${explicitPostId}`)
    : null;
}

export function normalizePostedRecord(record) {
  if (!record || record.success === false) return null;
  const groupId = String(record.groupId || record.id || "").trim();
  if (!/^\d+$/.test(groupId)) return null;

  const url = resolvePostedGroupUrl(groupId, record);
  const canComment = typeof record.canComment === "boolean" ? record.canComment : null;
  const pending = Boolean(record.pendingApproval || record.status === POSTED_STATUS.PENDING)
    || canComment === false
    || Boolean(url?.includes("/pending_posts/"));

  return {
    groupId,
    groupName: String(record.groupName || record.name || `Nhóm ${groupId}`).trim() || `Nhóm ${groupId}`,
    status: pending ? POSTED_STATUS.PENDING : POSTED_STATUS.PUBLISHED,
    pendingApproval: pending,
    canComment: pending ? false : canComment,
    approvalVerified: Boolean(record.approvalVerified || canComment !== null),
    publishedConfirmed: record.publishedConfirmed === true,
    postId: facebookPostIdFromIdentifier(record.postId) || facebookPostIdFromIdentifier(url),
    url,
    time: resultTime(record.time || record.updatedAt || record.finishedAt)
  };
}

export function postedResultsFromCampaign(snapshot) {
  if (!Array.isArray(snapshot?.results)) return [];
  const latestByGroup = new Map();
  for (const item of snapshot.results) {
    if (item?.success !== true) continue;
    const normalized = normalizePostedRecord(item);
    if (normalized) latestByGroup.set(normalized.groupId, normalized);
  }
  return [...latestByGroup.values()];
}

export function postedResultsFromCrosspost(state) {
  if (!Array.isArray(state?.groups)) return [];
  const successfulIds = new Set((state.selectedGroupIds || []).map(String));
  const pendingIds = new Set((Array.isArray(state.pendingGroupIds)
    ? state.pendingGroupIds
    : state.pendingApproval ? [...successfulIds] : []).map(String));
  const urlMap = state.resultUrls && typeof state.resultUrls === "object" && !Array.isArray(state.resultUrls)
    ? state.resultUrls
    : {};
  const allowLegacyFallback = state.groups.length <= NATIVE_GROUP_LIMIT;

  return state.groups.flatMap((group) => {
    const groupId = String(group?.id || "");
    if (!successfulIds.has(groupId)) return [];
    const row = normalizePostedRecord({
      groupId,
      groupName: group?.name,
      pendingApproval: pendingIds.has(groupId),
      canComment: typeof state.commentPermissions?.[groupId] === "boolean"
        ? state.commentPermissions[groupId]
        : null,
      resultUrls: urlMap,
      resultUrl: allowLegacyFallback ? state.resultUrl : null,
      time: state.finishedAt || state.updatedAt || state.createdAt
    });
    return row ? [row] : [];
  });
}

function rowFingerprint(rows) {
  return rows.map((row) => [
    row.groupId,
    row.groupName,
    row.status,
    String(row.canComment),
    row.url || ""
  ].join("\u001f")).join("\u001e");
}

export class PostedResultsPanel {
  constructor({ container, list, count }) {
    if (!container || !list || !count) {
      throw new Error("Thiếu thành phần giao diện danh sách nhóm đã đăng.");
    }
    this.container = container;
    this.list = list;
    this.count = count;
    this.lastFingerprint = null;
    this.render([]);
  }

  render(items = []) {
    const normalized = [];
    const seen = new Set();
    for (const candidate of Array.isArray(items) ? items : []) {
      const row = normalizePostedRecord(candidate);
      if (!row || seen.has(row.groupId)) continue;
      seen.add(row.groupId);
      normalized.push(row);
    }

    const fingerprint = rowFingerprint(normalized);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.count.textContent = `${normalized.length.toLocaleString("vi-VN")} nhóm`;
    this.container.dataset.hasResults = String(normalized.length > 0);

    const documentRef = this.list.ownerDocument || globalThis.document;
    const fragment = documentRef.createDocumentFragment();
    if (normalized.length === 0) {
      const empty = documentRef.createElement("p");
      empty.className = "posted-results__empty";
      empty.textContent = "Các nhóm đăng thành công sẽ xuất hiện tại đây.";
      fragment.appendChild(empty);
    } else {
      for (const row of normalized) fragment.appendChild(this.createRow(row, documentRef));
    }
    this.list.replaceChildren(fragment);
  }

  createRow(record, documentRef) {
    const row = documentRef.createElement("article");
    row.className = `posted-result posted-result--${record.status}`;
    row.dataset.groupId = record.groupId;

    const details = documentRef.createElement("div");
    details.className = "posted-result__details";
    const title = documentRef.createElement("strong");
    title.className = "posted-result__name";
    title.textContent = record.groupName;
    const meta = documentRef.createElement("div");
    meta.className = "posted-result__meta";
    const uid = documentRef.createElement("span");
    uid.className = "posted-result__uid";
    uid.textContent = `UID ${record.groupId}`;
    const status = documentRef.createElement("span");
    status.className = `posted-result__status posted-result__status--${record.status}`;
    status.textContent = record.pendingApproval
      ? "Spam · Chờ duyệt"
      : record.canComment === true
        ? "Đã duyệt"
        : "Đã đăng";
    meta.append(uid, status);
    details.append(title, meta);

    if (record.url) {
      const action = documentRef.createElement("a");
      action.className = "posted-result__view";
      action.href = record.url;
      action.target = "_blank";
      action.rel = "noopener noreferrer";
      action.setAttribute("aria-label", `Xem bài đã đăng trong ${record.groupName}`);
      action.textContent = "Xem";
      row.append(details, action);
    } else {
      const unavailable = documentRef.createElement("span");
      unavailable.className = "posted-result__unavailable";
      unavailable.textContent = "Chưa có link";
      row.append(details, unavailable);
    }
    return row;
  }
}
