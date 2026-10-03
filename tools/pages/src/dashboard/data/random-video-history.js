import { STORAGE_KEYS } from "../../shared/constants.js";
import { getLocal, setLocal } from "../../shared/chrome-storage.js";
import { videoFingerprint } from "../media/video-file.js";

export const RANDOM_VIDEO_STRATEGY = "persistent-shuffle-bag-v1";

const HISTORY_VERSION = 1;
const MAX_MIGRATED_RUNS = 20;

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeLastByPage(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [pageId, keys] of Object.entries(value)) {
    const normalizedId = String(pageId || "");
    if (!normalizedId) continue;
    result[normalizedId] = uniqueStrings(keys);
  }
  return result;
}

export function normalizeRandomVideoHistory(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: HISTORY_VERSION,
    cycle: Math.max(1, Math.floor(Number(source.cycle) || 1)),
    remaining: uniqueStrings(source.remaining),
    known: uniqueStrings(source.known),
    lastByPage: normalizeLastByPage(source.lastByPage),
    migratedRunIds: uniqueStrings(source.migratedRunIds).slice(-MAX_MIGRATED_RUNS),
    updatedAt: String(source.updatedAt || "")
  };
}

function secureRandomIndex(length) {
  if (length <= 1) return 0;
  const range = 0x1_0000_0000;
  const ceiling = Math.floor(range / length) * length;
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= ceiling);
  return random[0] % length;
}

function catalogFromVideos(videos) {
  const seen = new Set();
  const catalog = [];
  for (const video of Array.isArray(videos) ? videos : []) {
    const key = videoFingerprint(video);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    catalog.push({ key, video });
  }
  return catalog;
}

function takeRandomKey(bag, blocked, avoid, randomIndex) {
  const allowed = [];
  const preferred = [];
  for (let index = 0; index < bag.length; index += 1) {
    const key = bag[index];
    if (blocked.has(key)) continue;
    allowed.push(index);
    if (!avoid.has(key)) preferred.push(index);
  }
  const candidates = preferred.length ? preferred : allowed;
  if (!candidates.length) return null;
  const requestedIndex = Number(randomIndex(candidates.length));
  const safeIndex = Number.isInteger(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, candidates.length - 1))
    : 0;
  const bagIndex = candidates[safeIndex];
  return bag.splice(bagIndex, 1)[0] || null;
}

function seedFromPreviousRun(history, snapshot, videos) {
  if (!snapshot?.id
    || !snapshot.randomizeVideos
    || snapshot.randomStrategy === RANDOM_VIDEO_STRATEGY
    || history.migratedRunIds.includes(String(snapshot.id))) {
    return history;
  }

  const keyByLocalId = new Map(
    (Array.isArray(videos) ? videos : [])
      .map((video) => [String(video.id), videoFingerprint(video)])
  );
  const seededKeys = new Set();
  const selectedByPage = {};
  for (const job of Array.isArray(snapshot.jobs) ? snapshot.jobs : []) {
    const key = String(
      job?.videoFingerprint
      || keyByLocalId.get(String(job?.videoLocalId))
      || ""
    );
    const pageId = String(job?.pageId || "");
    if (!key || !pageId) continue;
    seededKeys.add(key);
    selectedByPage[pageId] ||= [];
    if (!selectedByPage[pageId].includes(key)) selectedByPage[pageId].push(key);
  }

  const known = new Set(history.known);
  seededKeys.forEach((key) => known.add(key));
  history.known = [...known];
  history.remaining = history.remaining.filter((key) => !seededKeys.has(key));
  history.lastByPage = {
    ...history.lastByPage,
    ...selectedByPage
  };
  history.migratedRunIds = [
    ...history.migratedRunIds,
    String(snapshot.id)
  ].slice(-MAX_MIGRATED_RUNS);
  return history;
}

export function createRandomVideoPlan(options = {}) {
  const history = normalizeRandomVideoHistory(options.history);
  const catalog = catalogFromVideos(options.videos);
  const pages = (Array.isArray(options.pages) ? options.pages : [])
    .filter((page) => page?.id);
  const countPerPage = Math.min(
    catalog.length,
    Math.max(0, Math.floor(Number(options.videosPerPage) || 0))
  );
  if (!catalog.length || !pages.length || !countPerPage) {
    return {
      selections: [],
      history,
      metadata: {
        strategy: RANDOM_VIDEO_STRATEGY,
        catalogSize: catalog.length,
        cycleStart: history.cycle,
        cycleEnd: history.cycle,
        wraps: 0,
        remaining: history.remaining.length
      }
    };
  }

  const randomIndex = typeof options.randomIndex === "function"
    ? options.randomIndex
    : secureRandomIndex;
  const videoByKey = new Map(catalog.map((item) => [item.key, item.video]));
  const currentKeys = catalog.map((item) => item.key);
  const currentSet = new Set(currentKeys);
  const known = new Set(history.known);
  const storedRemaining = uniqueStrings(history.remaining);
  const inactiveRemaining = storedRemaining.filter((key) => !currentSet.has(key));
  let bag = storedRemaining.filter((key) => currentSet.has(key));
  const inBag = new Set(bag);

  for (const key of currentKeys) {
    if (!known.has(key)) {
      known.add(key);
      if (!inBag.has(key)) {
        bag.push(key);
        inBag.add(key);
      }
    }
  }

  const cycleStart = history.cycle;
  let cycle = history.cycle;
  let wraps = 0;
  const selections = [];
  const nextLastByPage = { ...history.lastByPage };
  const selectedInRunCycle = new Set();

  for (const page of pages) {
    const pageId = String(page.id);
    const selectedKeys = [];
    const selectedSet = new Set();
    const previousSelection = new Set(
      (history.lastByPage[pageId] || []).filter((key) => currentSet.has(key))
    );

    while (selectedKeys.length < countPerPage) {
      let blocked = new Set([...selectedSet, ...selectedInRunCycle]);
      let key = takeRandomKey(bag, blocked, previousSelection, randomIndex);
      if (!key && selectedInRunCycle.size >= currentKeys.length) {
        selectedInRunCycle.clear();
        blocked = new Set(selectedSet);
        key = takeRandomKey(bag, blocked, previousSelection, randomIndex);
      }
      if (!key) {
        cycle += 1;
        wraps += 1;
        bag = [...currentKeys];
        blocked = new Set([...selectedSet, ...selectedInRunCycle]);
        key = takeRandomKey(bag, blocked, previousSelection, randomIndex);
      }
      if (!key) break;
      selectedKeys.push(key);
      selectedSet.add(key);
      selectedInRunCycle.add(key);
    }

    nextLastByPage[pageId] = [...selectedKeys];
    selections.push({
      pageId,
      videos: selectedKeys.map((key) => videoByKey.get(key)).filter(Boolean),
      keys: selectedKeys
    });
  }

  const nextHistory = {
    version: HISTORY_VERSION,
    cycle,
    remaining: uniqueStrings([...bag, ...inactiveRemaining]),
    known: [...known],
    lastByPage: nextLastByPage,
    migratedRunIds: history.migratedRunIds,
    updatedAt: new Date().toISOString()
  };
  return {
    selections,
    history: nextHistory,
    metadata: {
      strategy: RANDOM_VIDEO_STRATEGY,
      catalogSize: catalog.length,
      cycleStart,
      cycleEnd: cycle,
      wraps,
      remaining: bag.length
    }
  };
}

export async function reserveRandomVideoPlan(options = {}) {
  const stored = await getLocal(STORAGE_KEYS.RANDOM_VIDEO_HISTORY);
  const history = seedFromPreviousRun(
    normalizeRandomVideoHistory(stored[STORAGE_KEYS.RANDOM_VIDEO_HISTORY]),
    options.previousSnapshot,
    options.videos
  );
  const plan = createRandomVideoPlan({
    history,
    pages: options.pages,
    videos: options.videos,
    videosPerPage: options.videosPerPage
  });
  try {
    await setLocal({
      [STORAGE_KEYS.RANDOM_VIDEO_HISTORY]: plan.history
    });
  } catch (error) {
    throw new Error(
      "Không lưu được lịch sử random; đã dừng để tránh chọn trùng video. "
      + (error?.message || "")
    );
  }
  return plan;
}
