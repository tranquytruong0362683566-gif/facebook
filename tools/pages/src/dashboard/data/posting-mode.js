import { STORAGE_KEYS } from "../../shared/constants.js";
import { normalizePostingSpeed } from "./posting-speed.js";

const DRAFT_KEYS = Object.freeze([
  "postContent", "useVideoTitleAsContent", "aiEnabled", "commentAiEnabled",
  "videosPerPage", "randomizeVideos", "commentEnabled", "commentText",
  "uploadConcurrency", "jobDelay"
]);

export function normalizePostingMode(value) {
  return value === "photos" ? "photos" : "reels";
}

export function isPhotoMode(settings) {
  return settings?.contentMode === "photos";
}

export function queueStorageKey(settings) {
  return isPhotoMode(settings) ? STORAGE_KEYS.PHOTO_QUEUE : STORAGE_KEYS.QUEUE;
}

export function photoSettings(settings) {
  return {
    ...settings,
    useVideoTitleAsContent: false,
    aiEnabled: false,
    commentAiEnabled: false,
    videosPerPage: 0,
    randomizeVideos: false,
    uploadConcurrency: "fast"
  };
}

function draftSettings(settings) {
  return Object.fromEntries(DRAFT_KEYS.map((key) => [key, settings[key]]));
}

export function changePostingMode(settings, mode, defaults) {
  const currentMode = normalizePostingMode(settings.contentMode);
  const nextMode = normalizePostingMode(mode);
  if (nextMode === currentMode) return settings;
  const drafts = {
    ...settings.contentDrafts,
    [currentMode]: draftSettings(settings)
  };
  const next = {
    ...settings,
    ...draftSettings({ ...defaults, ...drafts[nextMode] }),
    contentMode: nextMode,
    contentDrafts: drafts
  };
  next.uploadConcurrency = normalizePostingSpeed(next.uploadConcurrency);
  return nextMode === "photos" ? photoSettings(next) : next;
}

export function publishedObjectId(result) {
  return result?.videoId || result?.photoId || result?.postId || "";
}
