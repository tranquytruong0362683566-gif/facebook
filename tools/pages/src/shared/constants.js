export const GRAPH_VERSION = "v26.0";

export const ADS_MANAGER = Object.freeze({
  HOME_URL: "https://adsmanager.facebook.com/",
  TOKEN_SOURCE_URL: "https://adsmanager.facebook.com/adsmanager/manage/campaigns"
});

export const LIMITS = Object.freeze({
  MIN_VIDEO_BYTES: 1024,
  MAX_VIDEO_BYTES: 4 * 1024 * 1024 * 1024,
  API_TIMEOUT_MS: 45_000,
  UPLOAD_TIMEOUT_MS: 60 * 60 * 1000,
  PROCESSING_TIMEOUT_MS: 5 * 60 * 1000,
  PROCESSING_POLL_MS: 5_000,
  PROCESSING_POLL_MAX_MS: 20_000,
  PROCESSING_CONCURRENCY: 8,
  COMMENT_CONCURRENCY: 3,
  COMMENT_DELAY_MS: 15_000,
  UPLOAD_MAX_ATTEMPTS: 4,
  UPLOAD_RETRY_BASE_MS: 5_000,
  TOKEN_RETRY_MS: 3_000,
  TOKEN_VERIFICATION_TIMEOUT_MS: 5 * 60 * 1000,
  LOCK_TTL_MS: 120_000,
  LOCK_HEARTBEAT_MS: 30_000
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "pageVideoPoster.settings.v1",
  OPENAI_API_KEY: "pageVideoPoster.openaiApiKey.v1",
  QUEUE: "pageVideoPoster.queue.v1",
  PHOTO_QUEUE: "pageVideoPoster.photoQueue.v1",
  CONTENT_TEMPLATES: "pageVideoPoster.contentTemplates.v1",
  RANDOM_VIDEO_HISTORY: "pageVideoPoster.randomVideoHistory.v1",
  RUN: "pageVideoPoster.run.v1",
  LOCK: "pageVideoPoster.lock.v1"
});

export const MESSAGE = Object.freeze({
  OPEN_DASHBOARD: "PAGE_VIDEO_OPEN_DASHBOARD",
  OPEN_ADS_MANAGER: "PAGE_VIDEO_OPEN_ADS_MANAGER",
  ADS_MANAGER_STATUS: "PAGE_VIDEO_ADS_MANAGER_STATUS",
  LOCK_ACQUIRE: "PAGE_VIDEO_LOCK_ACQUIRE",
  LOCK_HEARTBEAT: "PAGE_VIDEO_LOCK_HEARTBEAT",
  LOCK_RELEASE: "PAGE_VIDEO_LOCK_RELEASE",
  LOCK_STATUS: "PAGE_VIDEO_LOCK_STATUS",
  BADGE_UPDATE: "PAGE_VIDEO_BADGE_UPDATE"
});

export const JOB_STATUS = Object.freeze({
  PENDING: "pending",
  GENERATING: "generating",
  UPLOADING: "uploading",
  PROCESSING: "processing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  CANCELLED: "cancelled"
});

export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze([
  "mp4",
  "mov",
  "webm"
]);
