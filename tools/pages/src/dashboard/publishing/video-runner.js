import {
  JOB_STATUS,
  LIMITS,
  MESSAGE,
  STORAGE_KEYS
} from "../../shared/constants.js";
import { sendRequest } from "../../shared/runtime-messaging.js";
import { removeLocal, setLocal } from "../../shared/chrome-storage.js";
import {
  commentOnPublishedVideo,
  isAuthenticationError,
  uploadPageVideo,
  uploadPagePhoto,
  waitForPageVideo
} from "./facebook-api.js";
import { getVideo } from "../data/video-database.js";
import {
  RANDOM_VIDEO_STRATEGY,
  reserveRandomVideoPlan
} from "../data/random-video-history.js";
import { videoFingerprint } from "../media/video-file.js";
import { publishedObjectId } from "../data/posting-mode.js";
import { normalizePostingSpeed, postingSpeedHint } from "../data/posting-speed.js";
import { generateVideoContent, rewriteCommentContent, validateAiConfiguration } from "../ai/openai-content.js";

const TERMINAL_STATUSES = new Set([
  JOB_STATUS.SUCCEEDED,
  JOB_STATUS.FAILED,
  JOB_STATUS.INTERRUPTED,
  JOB_STATUS.CANCELLED
]);

function nowIso() {
  return new Date().toISOString();
}

function timestampOf(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function migratePageVideoTimes(snapshot) {
  const source = snapshot.pageLastVideoAt && typeof snapshot.pageLastVideoAt === "object"
    && !Array.isArray(snapshot.pageLastVideoAt)
    ? snapshot.pageLastVideoAt : {};
  const normalized = {};
  let changed = source !== snapshot.pageLastVideoAt;

  for (const [pageId, value] of Object.entries(source)) {
    const timestamp = timestampOf(value);
    if (!timestamp) {
      changed = true;
      continue;
    }
    normalized[String(pageId)] = new Date(timestamp).toISOString();
    if (normalized[String(pageId)] !== value) changed = true;
  }

  // Versions before 2.5.1 did not save this timestamp. Use the latest safe
  // point available so a restored queue does not post two videos together.
  for (const job of snapshot.jobs || []) {
    if (!publishedObjectId(job?.result)) continue;
    let timestamp = timestampOf(job.acceptedAt);
    if (!timestamp) {
      timestamp = timestampOf(job.finishedAt)
        || timestampOf(snapshot.updatedAt)
        || timestampOf(job.startedAt);
      if (timestamp) {
        job.acceptedAt = new Date(timestamp).toISOString();
        changed = true;
      }
    }
    const pageId = String(job.pageId || "");
    if (!pageId || !timestamp) continue;
    if (timestamp > timestampOf(normalized[pageId])) {
      normalized[pageId] = new Date(timestamp).toISOString();
      changed = true;
    }
  }

  snapshot.pageLastVideoAt = normalized;
  return changed;
}

function migrateBatchState(snapshot) {
  let changed = false;
  if (!Array.isArray(snapshot.batches) || !snapshot.batches.length) {
    snapshot.batches = [{ id: snapshot.id, number: 1, createdAt: snapshot.createdAt }];
    changed = true;
  }
  for (const job of snapshot.jobs) {
    if (!job.batchId) {
      job.batchId = snapshot.batches[0].id;
      job.batchNumber = 1;
      changed = true;
    }
    if (!job.aiConfig) {
      job.aiConfig = structuredClone(snapshot.ai || { enabled: false });
      changed = true;
    }
    if (!job.commentAiConfig) {
      job.commentAiConfig = { enabled: false };
      job.commentSource = job.commentText || "";
      changed = true;
    }
    if (job.delaySeconds === undefined) {
      job.delaySeconds = Math.max(0, Number(snapshot.delaySeconds) || 0);
      changed = true;
    }
  }
  if (migratePageVideoTimes(snapshot)) changed = true;
  return changed;
}

export function hasRetryableComment(job) {
  return Boolean(publishedObjectId(job?.result) && job.commentText && !job.result.comment?.success
    && job.result.comment?.error && !job.result.comment.error.unknownOutcome);
}

function publicError(error) {
  return {
    code: error?.code || "POST_FAILED",
    message: error?.message || "Đăng video thất bại.",
    httpStatus: error?.httpStatus ?? null,
    facebookCode: error?.facebookCode ?? null,
    facebookSubcode: error?.facebookSubcode ?? null,
    retriable: Boolean(error?.retriable),
    unknownOutcome: Boolean(error?.unknownOutcome),
    data: error?.data ?? null
  };
}

function abortedError() {
  return Object.assign(new Error("Đã dừng."), { code: "ABORTED" });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createSpeedSnapshot(value, jobs = [], previous = null) {
  const mode = normalizePostingSpeed(value ?? previous?.configured ?? previous?.mode);
  const pageCount = new Set(jobs.map((job) => String(job.pageId))).size;
  const slots = mode === "normal" ? 1 : Math.max(1, pageCount);
  return {
    mode,
    configured: mode,
    perPage: 1,
    min: 1,
    max: slots,
    current: slots,
    peak: Math.max(slots, Number(previous?.peak) || 0)
  };
}

function retryDelayMs(attempt) {
  const delay = Math.min(
    30_000,
    LIMITS.UPLOAD_RETRY_BASE_MS * (3 ** Math.max(0, attempt - 1))
  );
  return delay + Math.floor(Math.random() * 1_000);
}

class AsyncSemaphore {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 1));
    this.active = 0;
    this.waiters = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortedError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortedError());
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  drain() {
    while (this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(abortedError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }
}

export class VideoRunner {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.snapshot = null;
    this.pages = new Map();
    this.loopPromise = null;
    this.abortController = null;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.heartbeatTimer = null;
    this.lastPersistAt = 0;
    this.persistPromise = Promise.resolve();
    this.activePageIds = new Set();
    this.pageLastVideoAt = new Map();
    this.pageQueues = new Map();
    this.pageOrder = [];
    this.nextPageCursor = 0;
    this.schedulerWaiters = new Set();
    this.postTasks = new Set();
    this.videoReads = new Map();
    this.processingSemaphore = null;
    this.commentSemaphore = null;
    this.aiContentRequests = new Map();
    this.aiFatalErrors = new Map();
    this.batchApiKeys = new Map();
    this.enqueuePromise = Promise.resolve();
    this.enqueuing = 0;
    this.stopVersion = 0;
  }

  setPages(pages) {
    for (const page of pages || []) this.pages.set(String(page.id), { ...page });
  }

  getSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  emitState() {
    this.callbacks.onState?.(this.snapshot);
  }

  emitJob(job) {
    this.callbacks.onJob?.(structuredClone(job), this.snapshot);
  }

  async persist(force = false) {
    if (!this.snapshot) return;
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 1_500) return;
    this.lastPersistAt = now;
    const operation = this.persistPromise
      .catch(() => {})
      .then(() => {
        if (!this.snapshot) return;
        this.snapshot.updatedAt = nowIso();
        return setLocal({ [STORAGE_KEYS.RUN]: structuredClone(this.snapshot) });
      });
    this.persistPromise = operation;
    return operation;
  }

  async log(level, message, jobId = null) {
    if (!this.snapshot) return;
    const entry = {
      id: crypto.randomUUID(),
      at: nowIso(),
      level,
      message,
      jobId
    };
    this.snapshot.logs.push(entry);
    if (this.snapshot.logs.length > 1_000) this.snapshot.logs.splice(0, 100);
    this.callbacks.onLog?.(structuredClone(entry));
    await this.persist();
  }

  async buildSnapshot(config) {
    if (config.mediaType === "photo") {
      config = { ...config, videosPerPage: 0, randomizeVideos: false, ai: { enabled: false }, commentAi: { enabled: false } };
    }
    const jobs = [];
    const batchId = crypto.randomUUID();
    const createdAt = nowIso();
    const requested = Math.max(0, Math.floor(Number(config.videosPerPage) || 0));
    const perPage = requested > 0
      ? Math.min(requested, config.videos.length)
      : config.videos.length;
    const randomPlan = config.randomizeVideos
      ? await reserveRandomVideoPlan({
          pages: config.pages,
          videos: config.videos,
          videosPerPage: perPage,
          previousSnapshot: this.snapshot
        })
      : null;
    const randomVideosByPage = new Map(
      (randomPlan?.selections || []).map((selection) => [
        String(selection.pageId),
        selection.videos
      ])
    );

    config.pages.forEach((page) => {
      const pool = config.randomizeVideos
        ? (randomVideosByPage.get(String(page.id)) || [])
        : [...config.videos];
      pool.slice(0, perPage).forEach((video, videoIndex) => {
        jobs.push({
          id: crypto.randomUUID(),
          batchId,
          mediaType: config.mediaType === "photo" ? "photo" : "video",
          batchNumber: 1,
          delaySeconds: Math.max(0, Number(config.delaySeconds) || 0),
          aiConfig: structuredClone(config.ai || { enabled: false }),
          commentAiConfig: structuredClone(config.commentAi || { enabled: false }),
          videoLocalId: video.id,
          videoFingerprint: videoFingerprint(video),
          videoIndex,
          fileName: video.name,
          fileSize: video.size,
          title: String(video.title || ""),
          caption: String(video.caption || ""),
          aiSource: config.ai?.enabled ? String(video.caption || "") : "",
          aiGeneratedAt: null,
          aiModel: null,
          commentText: String(config.commentText || ""),
          commentSource: String(config.commentText || ""),
          commentAiGeneratedAt: null,
          commentAiModel: null,
          pageId: String(page.id),
          pageName: String(page.name || page.id),
          status: JOB_STATUS.PENDING,
          progress: 0,
          stage: "pending",
          attempts: 0,
          result: null,
          error: null,
          startedAt: null,
          acceptedAt: null,
          finishedAt: null
        });
      });
    });

    const initialLogs = [];
    if (randomPlan) {
      const metadata = randomPlan.metadata;
      initialLogs.push({
        id: crypto.randomUUID(),
        at: nowIso(),
        level: metadata.wraps ? "warning" : "info",
        message: metadata.wraps
          ? "Random không lặp đã dùng hết túi video và chuyển sang vòng mới "
            + metadata.wraps + " lần trong tiến trình này."
          : "Random không lặp đã giữ chỗ " + jobs.length
            + " lượt; còn " + metadata.remaining
            + " video chưa dùng trong vòng hiện tại.",
        jobId: null
      });
    }
    const speed = createSpeedSnapshot(config.uploadConcurrency, jobs);
    initialLogs.push({
      id: crypto.randomUUID(),
      at: nowIso(),
      level: "info",
      message: postingSpeedHint(speed.configured),
      jobId: null
    });

    return {
      id: crypto.randomUUID(),
      batches: [{ id: batchId, number: 1, createdAt }],
      status: "idle",
      videosPerPage: perPage,
      randomizeVideos: Boolean(config.randomizeVideos),
      ai: {
        enabled: Boolean(config.ai?.enabled),
        model: String(config.ai?.model || ""),
        prompt: String(config.ai?.prompt || "")
      },
      randomStrategy: config.randomizeVideos ? RANDOM_VIDEO_STRATEGY : null,
      randomSelection: randomPlan?.metadata || null,
      delaySeconds: Math.max(0, Number(config.delaySeconds) || 0),
      speed,
      createdAt,
      updatedAt: nowIso(),
      pageLastVideoAt: {},
      jobs,
      logs: initialLogs
    };
  }

  validateBatch(config, apiKey) {
    if (!Array.isArray(config.videos) || !config.videos.length) {
      throw new Error("Hàng đợi chưa có " + (config.mediaType === "photo" ? "ảnh." : "video."));
    }
    if (!Array.isArray(config.pages) || !config.pages.length) {
      throw new Error("Chưa chọn Page.");
    }
    if (config.ai?.enabled) {
      const validation = validateAiConfiguration({ apiKey, ...config.ai });
      if (validation) throw new Error(validation);
    }
    if (config.commentAi?.enabled) {
      const validation = validateAiConfiguration({ apiKey, ...config.commentAi, source: config.commentText });
      if (validation) throw new Error(validation);
    }
  }

  enqueueBatch(config) {
    // Copy the draft and credential synchronously, before any async reservation.
    const copied = structuredClone(config);
    if (copied.mediaType === "photo") {
      copied.ai = { enabled: false };
      copied.commentAi = { enabled: false };
    }
    const apiKey = this.callbacks.getAiApiKey?.() || "";
    this.validateBatch(copied, apiKey);
    const stopVersion = this.stopVersion;
    this.enqueuing += 1;
    const operation = this.enqueuePromise.catch(() => {}).then(async () => {
      if (!this.loopPromise) {
        await sendRequest(MESSAGE.LOCK_ACQUIRE, { runId: this.snapshot?.id || "preparing" });
      }
      return this.appendBatch(copied, apiKey, stopVersion);
    }).finally(async () => {
      this.enqueuing -= 1;
      this.wakeScheduler();
      if (!this.loopPromise && !this.enqueuing) {
        if (this.snapshot?.status === "paused" || !this.snapshot?.jobs.some((job) => job.status === JOB_STATUS.PENDING)) {
          await this.releaseLock();
        } else {
          this.launchPending();
        }
      }
    });
    this.enqueuePromise = operation;
    return operation;
  }

  async appendBatch(config, apiKey, stopVersion) {
    const addition = await this.buildSnapshot(config);
    // Commit alongside ordinary progress writes. Jobs do not enter the live
    // scheduler until their first write succeeds, even during worker startup.
    const operation = this.persistPromise.catch(() => {}).then(async () => {
      if (stopVersion !== this.stopVersion) throw abortedError();
      const previous = this.snapshot;
      if (previous) migrateBatchState(previous);
      const hasHistory = Boolean(previous?.jobs.length);
      const batchNumber = hasHistory ? previous.batches.length + 1 : 1;
      addition.batches[0].number = batchNumber;
      addition.jobs.forEach((job) => { job.batchNumber = batchNumber; });
      const candidate = hasHistory ? {
        ...previous,
        jobs: [...previous.jobs, ...addition.jobs],
        batches: [...previous.batches, ...addition.batches]
      } : addition;
      if (!this.loopPromise) {
        candidate.status = previous?.status === "paused" ? "paused" : "idle";
      }
      const keepSpeed = previous && (this.loopPromise || ["running", "pausing", "paused"].includes(previous.status));
      candidate.speed = createSpeedSnapshot(
        keepSpeed ? previous.speed?.configured : addition.speed.configured,
        candidate.jobs,
        previous?.speed
      );
      candidate.updatedAt = nowIso();
      await setLocal({ [STORAGE_KEYS.RUN]: structuredClone(candidate) });
      // Existing job objects are shared with the live snapshot, so their
      // progress cannot be rolled back by a slower storage write.
      if (previous && this.loopPromise) {
        candidate.status = previous.status;
        candidate.nextPageId = previous.nextPageId;
      }
      const stoppedDuringSave = stopVersion !== this.stopVersion;
      if (stoppedDuringSave) {
        for (const job of addition.jobs) {
          job.status = JOB_STATUS.CANCELLED;
          job.error = { code: "STOPPED", message: "Đã dừng theo yêu cầu." };
          job.finishedAt = nowIso();
        }
        candidate.status = "stopped";
        await setLocal({ [STORAGE_KEYS.RUN]: structuredClone(candidate) });
      }
      this.snapshot = candidate;
      this.setPages(config.pages);
      this.batchApiKeys.set(addition.batches[0].id, apiKey);
      if (this.loopPromise && this.pageQueues.size) this.registerJobs(addition.jobs);
      return { batchId: addition.batches[0].id, batchNumber, jobCount: addition.jobs.length, stoppedDuringSave };
    });
    this.persistPromise = operation;
    const added = await operation;
    this.emitState();
    this.wakeScheduler();
    if (added.stoppedDuringSave) throw abortedError();
    await this.log("info", "Đã thêm đợt " + added.batchNumber + ": " + addition.jobs.length
      + " lượt đăng trên " + config.pages.length + " Page.").catch(() => {});
    return added;
  }

  launchPending() {
    this.runPending().catch((error) => this.callbacks.onError?.(error));
  }

  async start(config) {
    await this.enqueueBatch(config);
    if (this.loopPromise) await this.loopPromise;
  }

  getJobApiKey(job) {
    return this.batchApiKeys.has(job.batchId)
      ? this.batchApiKeys.get(job.batchId) : this.callbacks.getAiApiKey?.();
  }

  registerJobs(jobs) {
    for (const job of jobs) {
      if (!this.pageQueues.has(job.pageId)) {
        this.pageQueues.set(job.pageId, []);
        this.pageOrder.push(job.pageId);
      }
      if (!this.pageQueues.get(job.pageId).some((item) => item.id === job.id)) {
        this.pageQueues.get(job.pageId).push(job);
      }
    }
  }

  async acquireLock() {
    await sendRequest(MESSAGE.LOCK_ACQUIRE, { runId: this.snapshot.id });
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      sendRequest(MESSAGE.LOCK_HEARTBEAT, { runId: this.snapshot?.id })
        .catch((error) => {
          this.log("error", "Mất khóa tiến trình: " + error.message).catch(() => {});
          this.stopRequested = true;
          this.abortController?.abort();
          this.wakeScheduler();
        });
    }, LIMITS.LOCK_HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async releaseLock() {
    this.stopHeartbeat();
    try {
      await sendRequest(MESSAGE.LOCK_RELEASE, { runId: this.snapshot?.id || "preparing" });
    } catch {
      // Khóa có TTL và sẽ tự hết hạn nếu service worker đã khởi động lại.
    }
  }

  updateBadge() {
    if (!this.snapshot) return;
    const done = this.snapshot.jobs.filter((job) => TERMINAL_STATUSES.has(job.status)).length;
    const total = this.snapshot.jobs.length;
    const failed = this.snapshot.jobs.some((job) => [
      JOB_STATUS.FAILED,
      JOB_STATUS.INTERRUPTED
    ].includes(job.status));
    const text = this.snapshot.status === "completed"
      ? (failed ? "!" : "✓")
      : String(done) + "/" + String(total);
    const color = failed ? "#c62828" : this.snapshot.status === "completed" ? "#188038" : "#1877f2";
    sendRequest(MESSAGE.BADGE_UPDATE, { text, color }).catch(() => {});
  }

  resetRuntimeState() {
    this.aiContentRequests = new Map();
    this.aiFatalErrors = new Map();
    for (const job of this.snapshot.jobs) {
      if (!job.aiGeneratedAt) continue;
      this.aiContentRequests.set(this.aiContentKey(job), Promise.resolve({
        title: job.title,
        caption: job.caption,
        generatedAt: job.aiGeneratedAt,
        model: job.aiModel
      }));
    }
    this.activePageIds = new Set();
    this.pageLastVideoAt = new Map(
      Object.entries(this.snapshot.pageLastVideoAt || {})
        .map(([pageId, value]) => [String(pageId), timestampOf(value)])
        .filter(([, timestamp]) => timestamp > 0)
    );
    this.pageQueues = new Map();
    this.pageOrder = [];
    this.nextPageCursor = 0;
    this.schedulerWaiters = new Set();
    this.postTasks = new Set();
    this.videoReads = new Map();
    this.processingSemaphore = new AsyncSemaphore(LIMITS.PROCESSING_CONCURRENCY);
    this.commentSemaphore = new AsyncSemaphore(LIMITS.COMMENT_CONCURRENCY);

    this.registerJobs(this.snapshot.jobs);
    const savedNextPage = this.pageOrder.indexOf(String(this.snapshot.nextPageId || ""));
    if (savedNextPage >= 0) this.nextPageCursor = savedNextPage;

    this.snapshot.speed = createSpeedSnapshot(
      this.snapshot.speed?.configured,
      this.snapshot.jobs,
      this.snapshot.speed
    );
  }

  wakeScheduler() {
    const waiters = [...this.schedulerWaiters];
    this.schedulerWaiters.clear();
    waiters.forEach((resolve) => resolve());
  }

  waitForScheduler(timeoutMs = 1_000) {
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        this.schedulerWaiters.delete(finish);
        resolve();
      };
      this.schedulerWaiters.add(finish);
      timer = setTimeout(finish, Math.max(25, Math.min(1_000, timeoutMs || 1_000)));
    });
  }

  hasPendingJobs() {
    return this.snapshot.jobs.some((job) => (
      job.status === JOB_STATUS.PENDING
    ));
  }

  claimNextUploadJob() {
    const totalPages = this.pageOrder.length;
    if (!totalPages) return { job: null, waitMs: 1_000 };
    const now = Date.now();
    let earliestReadyAt = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset < totalPages; offset += 1) {
      const index = (this.nextPageCursor + offset) % totalPages;
      const pageId = this.pageOrder[index];
      if (this.activePageIds.has(pageId)) continue;
      const job = this.pageQueues.get(pageId)?.find((candidate) => (
        candidate.status === JOB_STATUS.PENDING
      ));
      if (!job) continue;
      const lastVideoAt = Number(this.pageLastVideoAt.get(pageId)) || 0;
      const readyAt = lastVideoAt + (Math.max(0, Number(job.delaySeconds) || 0) * 1_000);
      if (!publishedObjectId(job.result) && readyAt > now) {
        // Normal mode preserves A1, B1, ... A2, B2 even when the next Page
        // must wait. Fast mode can use other Pages while this Page rests.
        if (this.snapshot.speed.mode === "normal") return { job: null, waitMs: readyAt - now };
        earliestReadyAt = Math.min(earliestReadyAt, readyAt);
        continue;
      }
      this.activePageIds.add(pageId);
      this.nextPageCursor = (index + 1) % totalPages;
      this.snapshot.nextPageId = this.pageOrder[this.nextPageCursor];
      return { job, waitMs: 0 };
    }

    return {
      job: null,
      waitMs: Number.isFinite(earliestReadyAt)
        ? Math.max(25, earliestReadyAt - now)
        : 1_000
    };
  }

  async acquireVideo(videoLocalId) {
    let entry = this.videoReads.get(videoLocalId);
    if (!entry) {
      entry = { promise: getVideo(videoLocalId), references: 0 };
      this.videoReads.set(videoLocalId, entry);
    }
    entry.references += 1;
    try {
      return await entry.promise;
    } catch (error) {
      entry.references -= 1;
      if (entry.references <= 0) this.videoReads.delete(videoLocalId);
      throw error;
    }
  }

  releaseVideo(videoLocalId) {
    const entry = this.videoReads.get(videoLocalId);
    if (!entry) return;
    entry.references -= 1;
    if (entry.references <= 0) this.videoReads.delete(videoLocalId);
  }

  queuePostTask(job, page) {
    let task;
    task = this.finalizeAcceptedJob(job, page)
      .catch(async (error) => {
        if (TERMINAL_STATUSES.has(job.status)) return;
        job.result ||= {};
        job.result.finalizationError = {
          code: error?.code || "POST_PUBLISH_FINALIZATION_FAILED",
          message: "Video đã được Facebook nhận nhưng bước hoàn tất gặp lỗi: "
            + (error?.message || "Lỗi không xác định."),
          unknownOutcome: Boolean(error?.unknownOutcome)
        };
        job.status = JOB_STATUS.SUCCEEDED;
        job.stage = job.result.processing?.ready ? "ready" : "accepted";
        job.progress = 100;
        job.error = null;
        job.finishedAt = nowIso();
        await this.persist(true).catch(() => {});
        this.emitJob(job);
      })
      .finally(() => {
        this.postTasks.delete(task);
        this.updateBadge();
        this.wakeScheduler();
      });
    this.postTasks.add(task);
    return task;
  }

  async finalizeAcceptedJob(job, page) {
    const result = job.result;
    if (!publishedObjectId(result)) throw new Error("Thiếu ID sau khi Facebook đã nhận bài đăng.");
    if (job.mediaType === "photo") result.processing = { ready: true, pending: false };

    if (job.stage !== "comment_pending" && !result.processing?.ready) {
      job.status = JOB_STATUS.PROCESSING;
      job.stage = "processing_queued";
      job.progress = Math.max(99, Number(job.progress) || 0);
      this.emitJob(job);
      const release = await this.processingSemaphore.acquire(this.abortController.signal);
      try {
        job.stage = "processing";
        this.emitJob(job);
        result.processing = await waitForPageVideo({
          page,
          videoId: result.videoId,
          signal: this.abortController.signal,
          onProgress: (progress) => {
            job.stage = "processing";
            job.progress = Number(progress.percent) || 99;
            this.emitJob(job);
            this.persist().catch(() => {});
          }
        });
      } catch (error) {
        result.processing = {
          ready: false,
          failed: true,
          statusError: publicError(error)
        };
        job.status = JOB_STATUS.FAILED;
        job.stage = "processing_failed";
        job.error = publicError(error);
        job.finishedAt = nowIso();
        await this.persist(true);
        this.emitJob(job);
        await this.log("error", "Facebook xử lý video thất bại: " + error.message, job.id);
        if (isAuthenticationError(error)) {
          this.stopRequested = true;
          this.wakeScheduler();
        }
        return;
      } finally {
        release();
      }
      await this.persist(true);
      this.emitJob(job);
    }

    if (job.commentText && !result.comment?.success && !result.comment?.error?.unknownOutcome) {
      if (this.stopRequested || this.abortController.signal.aborted) {
        result.comment = {
          success: false,
          error: {
            code: "COMMENT_SKIPPED_STOPPED",
            message: "Bài đã đăng; bỏ qua bình luận vì tiến trình đã dừng."
          }
        };
      } else {
        job.status = JOB_STATUS.PROCESSING;
        job.stage = "comment_wait";
        await this.persist(true);
        this.emitJob(job);
        await this.log(
          "info",
          "Bài đã được nhận; chờ 15 giây trước khi bình luận trên " + job.pageName + ".",
          job.id
        );
        try {
          await sleep(LIMITS.COMMENT_DELAY_MS, this.abortController.signal);
          const release = await this.commentSemaphore.acquire(this.abortController.signal);
          try {
            await this.prepareAiComment(job);
            job.stage = "commenting";
            await this.persist(true);
            this.emitJob(job);
            result.comment = await commentOnPublishedVideo({
              page,
              result,
              message: job.commentText,
              signal: this.abortController.signal,
            });
          } finally {
            release();
          }
          await this.log(
            "success",
            "Đã bình luận vào bài " + job.fileName + " trên " + job.pageName + ".",
            job.id
          );
        } catch (commentError) {
          result.comment = { success: false, error: publicError(commentError) };
          await this.log(
            this.stopRequested ? "warning" : "error",
            "Bài đã đăng nhưng bình luận không thành công: "
              + (commentError?.message || "Lỗi không xác định."),
            job.id
          );
          if (isAuthenticationError(commentError)) {
            this.stopRequested = true;
            this.wakeScheduler();
          }
        }
      }
    }

    job.status = JOB_STATUS.SUCCEEDED;
    job.stage = result.processing?.ready ? "ready" : "accepted";
    job.progress = 100;
    job.error = null;
    job.finishedAt = nowIso();
    await this.persist(true);
    this.emitJob(job);
    await this.log(
      "success",
      "Đã đăng " + job.fileName + " lên " + job.pageName + ".",
      job.id
    );
  }

  aiContentKey(job) {
    return JSON.stringify([job.batchId, job.videoLocalId, job.aiSource]);
  }

  async prepareAiContent(job) {
    if (!job.aiConfig?.enabled || job.aiGeneratedAt) return true;
    job.status = JOB_STATUS.GENERATING;
    job.stage = "ai_writing";
    job.startedAt ||= nowIso();
    job.error = null;
    await this.persist(true);
    this.emitJob(job);
    try {
      if (this.aiFatalErrors.has(job.batchId)) throw this.aiFatalErrors.get(job.batchId);
      if (this.stopRequested || this.abortController.signal.aborted) throw abortedError();
      const key = this.aiContentKey(job);
      let request = this.aiContentRequests.get(key);
      if (!request) {
        // Share one result per video in this run, including across parallel Pages.
        request = generateVideoContent({
          apiKey: this.getJobApiKey(job),
          model: job.aiConfig.model,
          prompt: job.aiConfig.prompt,
          source: job.aiSource,
          signal: this.abortController.signal,
          onRetry: ({ nextAttempt, delayMs }) => {
            this.log("warning", "AI viết " + job.fileName + ": thử lần " + nextAttempt
              + " sau " + Math.ceil(delayMs / 1_000) + " giây.", job.id).catch(() => {});
          }
        });
        this.aiContentRequests.set(key, request);
      }
      // Attach a rejection handler immediately; logging/storage may be slow.
      const outcome = request.then((content) => ({ content }), (error) => ({ error }));
      await this.log("info", "Đang viết tiêu đề và nội dung AI: " + job.fileName + ".", job.id);
      const { content, error } = await outcome;
      if (error) throw error;
      if (this.stopRequested || this.abortController.signal.aborted) throw abortedError();
      job.title = content.title;
      job.caption = content.caption;
      job.aiGeneratedAt = content.generatedAt;
      job.aiModel = content.model;
      job.status = JOB_STATUS.PENDING;
      job.stage = "ai_ready";
      // Commit generated text before crossing the Facebook upload boundary.
      await this.persist(true);
      this.emitJob(job);
      await this.log("success", "AI đã viết xong: " + job.title + ".", job.id);
      return true;
    } catch (error) {
      const stopped = this.stopRequested || error?.code === "ABORTED";
      if (error?.fatal) this.aiFatalErrors.set(job.batchId, error);
      job.status = stopped ? JOB_STATUS.CANCELLED : JOB_STATUS.FAILED;
      job.stage = "ai_failed";
      job.error = publicError(error);
      job.finishedAt = nowIso();
      await this.persist(true);
      this.emitJob(job);
      await this.log(stopped ? "warning" : "error",
        "Chưa đăng " + job.fileName + ": " + (error.message || "Lỗi tạo nội dung AI."), job.id);
      return false;
    }
  }

  async prepareAiComment(job) {
    if (!job.commentAiConfig?.enabled || job.commentAiGeneratedAt) return;
    job.stage = "comment_ai_writing";
    await this.persist(true);
    this.emitJob(job);
    await this.log("info", "AI đang viết lại bình luận cho " + job.fileName + " trên " + job.pageName + ".", job.id);
    const content = await rewriteCommentContent({
      apiKey: this.getJobApiKey(job),
      model: job.commentAiConfig.model,
      prompt: job.commentAiConfig.prompt,
      source: job.commentSource,
      signal: this.abortController.signal,
      onRetry: ({ nextAttempt, delayMs }) => {
        this.log("warning", "AI bình luận thử lần " + nextAttempt + " sau "
          + Math.ceil(delayMs / 1_000) + " giây.", job.id).catch(() => {});
      }
    });
    if (this.stopRequested || this.abortController.signal.aborted) throw abortedError();
    job.commentText = content.comment;
    job.commentAiGeneratedAt = content.generatedAt;
    job.commentAiModel = content.model;
    await this.persist(true);
    this.emitJob(job);
  }

  async executeUploadJob(job) {
    const page = this.pages.get(job.pageId);
    if (!page?.accessToken) {
      job.status = JOB_STATUS.FAILED;
      job.error = {
        code: "PAGE_TOKEN_NOT_LOADED",
        message: "Chưa tải Page Token. Hãy tải lại danh sách Page trước khi tiếp tục."
      };
      job.finishedAt = nowIso();
      await this.persist(true);
      this.emitJob(job);
      return;
    }

    if (publishedObjectId(job.result)) {
      const commentPending = job.stage === "comment_pending";
      job.status = JOB_STATUS.PROCESSING;
      job.stage = commentPending ? "comment_pending" : "processing_queued";
      job.progress = Math.max(99, Number(job.progress) || 0);
      this.emitJob(job);
      await this.queuePostTask(job, page);
      return;
    }

    let file;
    try {
      file = await this.acquireVideo(job.videoLocalId);
    } catch (error) {
      job.status = JOB_STATUS.FAILED;
      job.error = {
        code: "VIDEO_STORAGE_ERROR",
        message: "Không đọc được tệp: " + error.message
      };
      job.finishedAt = nowIso();
      await this.persist(true);
      this.emitJob(job);
      return;
    }
    if (!file) {
      this.releaseVideo(job.videoLocalId);
      job.status = JOB_STATUS.FAILED;
      job.error = {
        code: "VIDEO_FILE_MISSING",
        message: "Tệp không còn trong bộ nhớ cục bộ."
      };
      job.finishedAt = nowIso();
      await this.persist(true);
      this.emitJob(job);
      return;
    }

    try {
      if (!await this.prepareAiContent(job)) return;
      while (job.attempts < LIMITS.UPLOAD_MAX_ATTEMPTS && !this.stopRequested) {
        job.attempts += 1;
        job.status = JOB_STATUS.UPLOADING;
        job.stage = "upload";
        job.progress = 0;
        job.startedAt ||= nowIso();
        job.error = null;
        await this.persist(true);
        this.emitJob(job);
        await this.log(
          "info",
          "Đang đăng " + job.fileName + " lên " + job.pageName
            + " (lần " + job.attempts + "/" + LIMITS.UPLOAD_MAX_ATTEMPTS + ").",
          job.id
        );

        try {
          const upload = job.mediaType === "photo" ? uploadPagePhoto : uploadPageVideo;
          const result = await upload({
            page,
            file,
            title: job.title,
            caption: job.caption,
            signal: this.abortController.signal,
            onProgress: (progress) => {
              job.stage = "upload";
              job.progress = Number(progress.percent) || 0;
              job.status = JOB_STATUS.UPLOADING;
              this.emitJob(job);
              this.persist().catch(() => {});
            }
          });

          job.result = result;
          const acceptedAt = Date.now();
          job.acceptedAt = new Date(acceptedAt).toISOString();
          this.pageLastVideoAt.set(job.pageId, acceptedAt);
          this.snapshot.pageLastVideoAt ||= {};
          this.snapshot.pageLastVideoAt[job.pageId] = job.acceptedAt;
          job.error = null;
          job.progress = 99;
          job.status = JOB_STATUS.PROCESSING;
          job.stage = "processing_queued";
          await this.persist(true);
          this.emitJob(job);
          await this.log(
            "success",
            "Facebook đã nhận " + job.fileName + " trên " + job.pageName
              + "; đang hoàn tất bài đăng.",
            job.id
          );
          await this.queuePostTask(job, page);
          return;
        } catch (error) {
          if (this.stopRequested || error?.code === "ABORTED") {
            job.status = error?.unknownOutcome
              ? JOB_STATUS.INTERRUPTED
              : JOB_STATUS.CANCELLED;
            job.error = publicError(error);
            job.finishedAt = nowIso();
            await this.persist(true);
            this.emitJob(job);
            return;
          }

          const canRetry = Boolean(error?.retriable)
            && !error?.unknownOutcome
            && job.attempts < LIMITS.UPLOAD_MAX_ATTEMPTS;
          if (canRetry) {
            const delayMs = retryDelayMs(job.attempts);
            job.status = JOB_STATUS.PENDING;
            job.error = publicError(error);
            this.emitJob(job);
            await this.log(
              "warning",
              "Lỗi tạm thời: " + error.message + ". Thử lại sau khoảng "
                + Math.ceil(delayMs / 1_000) + " giây.",
              job.id
            );
            try {
              await sleep(delayMs, this.abortController.signal);
            } catch {
              job.status = JOB_STATUS.CANCELLED;
              job.error = { code: "STOPPED", message: "Đã dừng theo yêu cầu." };
              job.finishedAt = nowIso();
              await this.persist(true);
              this.emitJob(job);
              return;
            }
            continue;
          }

          job.status = JOB_STATUS.FAILED;
          job.error = publicError(error);
          job.finishedAt = nowIso();
          await this.persist(true);
          this.emitJob(job);
          await this.log("error", error.message || "Đăng thất bại.", job.id);
          if (isAuthenticationError(error)) {
            this.stopRequested = true;
            this.wakeScheduler();
            await this.log("error", "Token đã hết hạn hoặc không hợp lệ; dừng cấp lượt đăng mới.");
          }
          return;
        }
      }
    } finally {
      this.releaseVideo(job.videoLocalId);
    }
  }

  async dispatchPendingJobs() {
    const tasks = new Set();
    let failure = null;
    const launch = (job) => {
      let task;
      task = this.executeUploadJob(job)
        .catch((error) => {
          failure ||= error;
          this.stopRequested = true;
          this.abortController?.abort();
          this.wakeScheduler();
        })
        .finally(() => {
          tasks.delete(task);
          this.activePageIds.delete(job.pageId);
          this.updateBadge();
          this.wakeScheduler();
        });
      tasks.add(task);
    };

    try {
      while (!this.stopRequested && !this.pauseRequested) {
        let waitMs = 1_000;
        // Re-evaluate after every wake: newly saved Pages can start during
        // the current batch without waiting for an existing Page to finish.
        const slots = this.snapshot.speed.mode === "normal" ? 1 : this.pageOrder.length;
        while (tasks.size < slots && !this.stopRequested && !this.pauseRequested) {
          const claimed = this.claimNextUploadJob();
          waitMs = claimed.waitMs;
          if (!claimed.job) break;
          launch(claimed.job);
        }
        if (!tasks.size && !this.hasPendingJobs() && !this.enqueuing) break;
        await this.waitForScheduler(waitMs);
      }
    } finally {
      await Promise.allSettled([...tasks]);
      await this.waitForPostTasks();
    }
    if (failure) throw failure;
  }

  async waitForPostTasks() {
    while (this.postTasks.size) {
      await Promise.allSettled([...this.postTasks]);
    }
  }

  runPending() {
    if (!this.snapshot) return Promise.reject(new Error("Không có trạng thái tiến trình."));
    if (this.loopPromise) return this.loopPromise;
    if (!this.snapshot.jobs.some((job) => job.status === JOB_STATUS.PENDING)) return Promise.resolve();
    this.pauseRequested = false;
    this.stopRequested = false;
    // Claim the lifecycle synchronously so fast consecutive enqueues cannot
    // create two sets of workers while the lock/storage awaits are in flight.
    this.loopPromise = this.runSession();
    return this.loopPromise;
  }

  async runSession() {
    let failed = false;
    let locked = false;
    try {
      await this.acquireLock();
      locked = true;
      this.abortController = new AbortController();
      if (this.stopRequested) this.abortController.abort();
      this.snapshot.status = this.pauseRequested ? "pausing" : "running";
      this.resetRuntimeState();
      await this.persist(true);
      this.emitState();
      this.updateBadge();
      await this.runLoop();
    } catch (error) {
      failed = true;
      this.stopRequested = true;
      this.abortController?.abort();
      this.wakeScheduler();
      if (this.snapshot && locked) {
        this.snapshot.status = "stopped";
        await this.log("error", "Tiến trình dừng do lỗi: " + error.message).catch(() => {});
      }
      throw error;
    } finally {
      // Enqueues never wait for this lifecycle, so draining mutations here
      // also covers additions that arrive during completion/persistence.
      while (this.enqueuing) await this.waitForScheduler();
      if (locked) {
        await this.releaseLock();
        await this.persist(true).catch(() => {});
      }
      this.abortController = null;
      this.loopPromise = null;
      this.emitState();
      this.updateBadge();
      if (!failed && !this.stopRequested && !this.pauseRequested
        && this.snapshot?.jobs.some((job) => job.status === JOB_STATUS.PENDING)) {
        this.launchPending();
      }
    }
  }

  async runLoop() {
    await this.dispatchPendingJobs();

    if (this.stopRequested) {
      for (const job of this.snapshot.jobs) {
        if (job.status !== JOB_STATUS.PENDING) continue;
        if (publishedObjectId(job.result)) {
          job.status = JOB_STATUS.SUCCEEDED;
          job.stage = job.result.processing?.ready ? "ready" : "accepted";
          job.progress = 100;
          job.error = null;
        } else {
          job.status = JOB_STATUS.CANCELLED;
          job.error = { code: "STOPPED", message: "Đã dừng theo yêu cầu." };
        }
        job.finishedAt = nowIso();
        this.emitJob(job);
      }
      this.snapshot.status = "stopped";
      await this.log("warning", "Đã dừng tiến trình.");
      return;
    }

    const stillPending = this.snapshot.jobs.some((job) => job.status === JOB_STATUS.PENDING);
    if (this.pauseRequested && stillPending) {
      this.snapshot.status = "paused";
      await this.log("info", "Đã tạm dừng sau các lượt đang hoạt động.");
      return;
    }

    this.snapshot.status = "completed";
    const succeeded = this.snapshot.jobs.filter((job) => job.status === JOB_STATUS.SUCCEEDED).length;
    const failed = this.snapshot.jobs.length - succeeded;
    await this.log(
      failed ? "warning" : "success",
      "Hoàn tất: " + succeeded + " thành công, " + failed + " chưa thành công."
    );
  }

  async requestPause() {
    if (!this.loopPromise || this.snapshot?.status !== "running") return;
    this.pauseRequested = true;
    this.snapshot.status = "pausing";
    this.wakeScheduler();
    await this.persist(true);
    this.emitState();
    await this.log("info", "Sẽ tạm dừng sau các lượt đang hoạt động.");
  }

  async resume() {
    if (this.loopPromise) return this.loopPromise;
    for (const job of this.snapshot?.jobs || []) {
      if (job.status !== JOB_STATUS.PENDING) continue;
      const configs = [];
      if (job.aiConfig?.enabled && !job.aiGeneratedAt && !publishedObjectId(job.result)) configs.push(job.aiConfig);
      if (job.commentAiConfig?.enabled && !job.commentAiGeneratedAt && !job.result?.comment?.success) configs.push(job.commentAiConfig);
      for (const config of configs) {
        const validation = validateAiConfiguration({ apiKey: this.getJobApiKey(job), ...config });
        if (validation) throw new Error(validation);
      }
    }
    return this.runPending();
  }

  async retryFailed(aiConfig = null, commentAiConfig = null) {
    if (this.loopPromise || this.enqueuing) throw new Error("Hãy dừng hoặc chờ tiến trình hiện tại hoàn tất.");
    const candidates = (this.snapshot?.jobs || []).filter((job) =>
      [JOB_STATUS.FAILED, JOB_STATUS.INTERRUPTED].includes(job.status) || hasRetryableComment(job));
    for (const job of candidates) {
      if (job.error?.unknownOutcome) continue;
      const textConfig = aiConfig || job.aiConfig;
      const commentConfig = commentAiConfig || job.commentAiConfig;
      if (job.aiConfig?.enabled && !job.aiGeneratedAt && !publishedObjectId(job.result)) {
        const validation = validateAiConfiguration({ apiKey: this.callbacks.getAiApiKey?.(), ...textConfig });
        if (validation) throw new Error(validation);
      }
      if (job.commentAiConfig?.enabled && !job.commentAiGeneratedAt && !job.result?.comment?.success) {
        const validation = validateAiConfiguration({ apiKey: this.callbacks.getAiApiKey?.(), ...commentConfig, source: job.commentSource });
        if (validation) throw new Error(validation);
      }
    }
    for (const job of candidates) {
      if (job.error?.unknownOutcome) continue;
      if (job.aiConfig?.enabled && aiConfig && !job.aiGeneratedAt && !publishedObjectId(job.result)) {
        job.aiConfig = { ...aiConfig, enabled: true };
      }
      if (job.commentAiConfig?.enabled && commentAiConfig && !job.commentAiGeneratedAt) {
        job.commentAiConfig = { ...commentAiConfig, enabled: true };
      }
      this.batchApiKeys.set(job.batchId, this.callbacks.getAiApiKey?.() || "");
    }
    let count = 0;
    let unsafe = 0;
    for (const job of this.snapshot?.jobs || []) {
      if (![JOB_STATUS.FAILED, JOB_STATUS.INTERRUPTED].includes(job.status) && !hasRetryableComment(job)) continue;
      if (publishedObjectId(job.result)) {
        const retryComment = hasRetryableComment(job);
        job.status = JOB_STATUS.PENDING;
        job.stage = retryComment ? "comment_pending" : "processing_pending";
        if (retryComment) delete job.result.comment;
        job.progress = Math.max(99, Number(job.progress) || 0);
        job.error = null;
        job.finishedAt = null;
        count += 1;
        continue;
      }
      if (job.error?.unknownOutcome) {
        unsafe += 1;
        continue;
      }
      job.status = JOB_STATUS.PENDING;
      job.stage = "pending";
      job.progress = 0;
      job.error = null;
      job.result = null;
      job.startedAt = null;
      job.finishedAt = null;
      job.attempts = 0;
      count += 1;
    }
    if (!count) {
      throw new Error(unsafe
        ? "Các mục lỗi có kết quả chưa xác định nên không tự đăng lại để tránh trùng bài."
        : "Không có mục lỗi để thử lại.");
    }
    await this.persist(true);
    this.emitState();
    if (unsafe) {
      await this.log(
        "warning",
        "Bỏ qua " + unsafe + " mục có kết quả chưa xác định để tránh đăng trùng."
      );
    }
    return this.runPending();
  }

  async stop() {
    if (!this.snapshot) return;
    this.stopRequested = true;
    this.stopVersion += 1;
    this.pauseRequested = false;
    this.abortController?.abort();
    this.wakeScheduler();
    if (!this.loopPromise) {
      for (const job of this.snapshot.jobs) {
        if (job.status !== JOB_STATUS.PENDING) continue;
        if (publishedObjectId(job.result)) {
          job.status = JOB_STATUS.SUCCEEDED;
          job.stage = job.result.processing?.ready ? "ready" : "accepted";
          job.progress = 100;
          job.error = null;
        } else {
          job.status = JOB_STATUS.CANCELLED;
          job.error = { code: "STOPPED", message: "Đã dừng theo yêu cầu." };
        }
        job.finishedAt = nowIso();
      }
      this.snapshot.status = "stopped";
      await this.persist(true);
      this.emitState();
    }
  }

  async clear() {
    if (this.loopPromise || this.enqueuing) throw new Error("Không thể xóa kết quả khi tiến trình đang chạy hoặc thêm đợt.");
    const runId = "clearing-" + crypto.randomUUID();
    // Also used at dashboard startup. Never erase a different live tab's run.
    await sendRequest(MESSAGE.LOCK_ACQUIRE, { runId });
    try {
      await this.persistPromise.catch(() => {});
      await removeLocal(STORAGE_KEYS.RUN);
      this.snapshot = null;
      this.batchApiKeys.clear();
      this.aiContentRequests.clear();
      this.aiFatalErrors.clear();
      this.pageLastVideoAt.clear();
      this.pageQueues.clear();
      this.pageOrder = [];
      this.pauseRequested = false;
      this.stopRequested = false;
      this.stopHeartbeat();
      await sendRequest(MESSAGE.BADGE_UPDATE, { text: "", color: "#1877f2" }).catch(() => {});
      this.emitState();
    } finally {
      await sendRequest(MESSAGE.LOCK_RELEASE, { runId }).catch(() => {});
    }
  }
}
