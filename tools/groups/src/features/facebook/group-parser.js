function groupInputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseFacebookGroupUid(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) return raw;

  let urlValue = raw;
  if (/^(?:www\.|m\.|mbasic\.)?facebook\.com\//i.test(urlValue)) {
    urlValue = `https://${urlValue}`;
  }
  try {
    const url = new URL(urlValue);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.hostname !== "facebook.com" && !url.hostname.endsWith(".facebook.com")) return null;
    return url.pathname.match(/^\/groups\/(\d+)(?:\/|$)/i)?.[1] || null;
  } catch {
    return null;
  }
}

export function createManualFacebookGroup(value) {
  const id = parseFacebookGroupUid(value);
  if (!id) {
    throw groupInputError(
      "INVALID_MANUAL_GROUP_UID",
      "UID nhóm không hợp lệ. Hãy nhập dãy số UID hoặc liên kết Facebook có dạng /groups/UID."
    );
  }
  return {
    id,
    name: `Nhóm UID ${id}`,
    url: `https://www.facebook.com/groups/${id}`,
    pic: "",
    manuallyAdded: true
  };
}

export function parseFacebookGroupUidList(value) {
  const ids = [];
  const invalidValues = [];
  const seen = new Set();
  const tokens = String(value || "").split(/[\s,;|]+/).map((item) => item.trim()).filter(Boolean);
  for (const token of tokens) {
    const id = parseFacebookGroupUid(token);
    if (!id) {
      invalidValues.push(token);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, invalidValues };
}

export function formatFacebookGroupUidList(values = []) {
  const ids = [];
  const seen = new Set();
  for (const value of Array.from(values || [])) {
    const id = parseFacebookGroupUid(value?.id || value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.join("\n");
}

export function resolveFacebookGroupsFromUidList(value, knownGroups = []) {
  const parsed = parseFacebookGroupUidList(value);
  const knownById = new Map();
  for (const candidate of Array.isArray(knownGroups) ? knownGroups : []) {
    const id = String(candidate?.id || "");
    if (!/^\d+$/.test(id)) continue;
    knownById.set(id, {
      ...candidate,
      id,
      name: String(candidate.name || `Nhóm UID ${id}`),
      url: candidate.url || `https://www.facebook.com/groups/${id}`
    });
  }
  return {
    ...parsed,
    groups: parsed.ids.map((id) => knownById.get(id) || createManualFacebookGroup(id))
  };
}

export function mergeFetchedGroupsWithUidList(fetchedGroups = [], currentGroups = [], uidList = "") {
  const fetchedById = new Map();
  for (const candidate of Array.isArray(fetchedGroups) ? fetchedGroups : []) {
    const id = String(candidate?.id || "");
    const name = String(candidate?.name || "").trim();
    if (!/^\d+$/.test(id) || !name || fetchedById.has(id)) continue;
    fetchedById.set(id, {
      ...candidate,
      id,
      name,
      url: candidate.url || `https://www.facebook.com/groups/${id}`
    });
  }
  const fetched = [...fetchedById.values()];
  const resolved = resolveFacebookGroupsFromUidList(uidList, [
    ...(Array.isArray(currentGroups) ? currentGroups : []),
    ...fetched
  ]);
  const customSelectedGroups = resolved.groups.filter((group) => !fetchedById.has(group.id));
  return {
    groups: [...customSelectedGroups, ...fetched],
    selectedGroupIds: new Set(resolved.ids),
    invalidValues: resolved.invalidValues
  };
}
