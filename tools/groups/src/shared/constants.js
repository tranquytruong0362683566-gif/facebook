export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "fbgp_settings_v1",
  DRAFT: "fbgp_draft_v1",
  RUNTIME: "fbgp_runtime_v1",
  PROFILE: "fbgp_profile_v1",
  VIDEO_SESSIONS: "fbgp_video_sessions_v1",
  NATIVE_GROUP_JOB: "fbgp_native_group_job_v1"
});

export const RUN_STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  WAITING: "waiting",
  PAUSED: "paused",
  COMPLETED: "completed",
  STOPPED: "stopped"
});

export const DEFAULT_SETTINGS = Object.freeze({
  fixedSeconds: 30
});

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MIN_IMAGE_BYTES = 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MIN_VIDEO_BYTES = 1024;
export const RETRY_DELAY_MS = 8000;
export const CROSSPOST_RETRY_DELAY_MS = 4000;
export const CROSSPOST_MAX_TRANSIENT_RETRIES = 1;
export const AUTO_PAUSE_FAILURES = 5;
export const NATIVE_ADDITIONAL_GROUP_LIMIT = 9;
export const NATIVE_GROUP_LIMIT = NATIVE_ADDITIONAL_GROUP_LIMIT + 1;
