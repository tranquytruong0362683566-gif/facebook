import {
  AUTO_PAUSE_FAILURES,
  RETRY_DELAY_MS,
  RUN_STATUS
} from "../../shared/constants.js";
import { classifyFacebookError } from "../facebook/facebook-errors.js";
import { exactFacebookPostUrl } from "../facebook/post-links.js";
import { cloneData } from "../../shared/utils.js";

function classifyThrownPublishError(error, retryAllowed = true) {
  if (["FACEBOOK_ACTOR_CHANGED", "VIDEO_ACTOR_CHANGED"].includes(error?.code)) {
    return {
      type: "FACEBOOK_ACTOR_CHANGED",
      shouldSkip: false,
      shouldRetry: false,
      shouldWarn: true,
      shouldStop: true,
      freshToken: null,
      logMessage: error.message || "Tư cách Facebook đã thay đổi; cần làm mới phiên."
    };
  }
  return {
    type: "NETWORK_OR_UPLOAD_ERROR",
    shouldSkip: false,
    shouldRetry: retryAllowed,
    shouldWarn: false,
    shouldStop: false,
    freshToken: null,
    logMessage: error?.message || (retryAllowed
      ? "Lỗi mạng hoặc tải tệp đính kèm."
      : "Lỗi mạng hoặc tải tệp đính kèm sau lần thử lại.")
  };
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function calculateDelaySeconds(delay = {}) {
  return Math.max(0, Math.min(86400, Number(delay.fixedSeconds) || 0));
}

export function estimateCampaignSeconds(groupCount, delay, safetyBreak = null) {
  if (groupCount <= 0) return 0;
  const averageDelay = calculateDelaySeconds(delay);
  const requestTime = groupCount * 5;
  const delayTime = Math.max(0, groupCount - 1) * averageDelay;
  let breakTime = 0;
  if (safetyBreak?.enabled && safetyBreak.afterPosts > 0 && safetyBreak.durationSeconds > 0) {
    const breaks = Math.floor((groupCount - 1) / safetyBreak.afterPosts);
    breakTime = breaks * safetyBreak.durationSeconds;
  }
  return Math.round(requestTime + delayTime + breakTime);
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút ${seconds % 60 ? `${seconds % 60} giây` : ""}`.trim();
  const hours = Math.floor(minutes / 60);
  return `${hours} giờ ${minutes % 60 ? `${minutes % 60} phút` : ""}`.trim();
}

export function formatResultSummary({ successCount = 0, pendingCount = 0, failCount = 0 } = {}) {
  const visible = Math.max(0, Number(successCount) || 0).toLocaleString("vi-VN");
  const pending = Math.max(0, Number(pendingCount) || 0).toLocaleString("vi-VN");
  const failed = Math.max(0, Number(failCount) || 0).toLocaleString("vi-VN");
  return `${visible} bài đã duyệt · ${pending} bài spam/chờ duyệt · ${failed} bài lỗi`;
}

function emptyState() {
  return {
    version: 3,
    status: RUN_STATUS.IDLE,
    phase: "idle",
    queue: [],
    posts: [],
    previews: {},
    delay: null,
    safetyBreak: null,
    scheduledPublishTime: null,
    hasImage: false,
    hasVideo: false,
    currentIndex: 0,
    currentPostIndex: 0,
    successCount: 0,
    pendingCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    skipList: [],
    results: [],
    pendingDelayMs: 0,
    pendingDelayKind: null,
    startedAt: null,
    finishedAt: null,
    stoppedReason: null,
    updatedAt: Date.now()
  };
}

export class CampaignRunner {
  constructor({ api, onState, onLog, onProgress, onResult, onComplete }) {
    this.api = api;
    this.onState = onState;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.onResult = onResult;
    this.onComplete = onComplete;
    this.state = emptyState();
    this.imageFile = null;
    this.videoFile = null;
    this.stopRequested = false;
    this.resumeResolver = null;
    this.activeTimer = null;
    this.activeTimerResolver = null;
    this.runPromise = null;
    this.runId = 0;
  }

  snapshot() {
    return cloneData({ ...this.state, updatedAt: Date.now() });
  }

  async emitState() {
    this.state.updatedAt = Date.now();
    await this.onState?.(this.snapshot());
    this.onProgress?.(this.snapshot());
  }

  log(level, message, details = null) {
    this.onLog?.({ level, message, details, time: Date.now() });
  }

  setApi(api) {
    this.api = api;
  }

  async start(config) {
    if (this.runPromise && ![RUN_STATUS.COMPLETED, RUN_STATUS.STOPPED].includes(this.state.status)) {
      throw new Error("Đã có một chiến dịch đang chạy.");
    }
    if (!Array.isArray(config.queue) || config.queue.length === 0) {
      throw new Error("Chưa chọn nhóm để đăng.");
    }
    if (!Array.isArray(config.posts) || config.posts.length === 0 || config.posts.every((post) => !post.trim())) {
      throw new Error("Cần ít nhất một nội dung bài đăng.");
    }
    this.stopRequested = false;
    this.imageFile = config.imageFile || null;
    this.videoFile = config.videoFile || null;
    this.state = {
      ...emptyState(),
      status: RUN_STATUS.RUNNING,
      phase: "ready",
      queue: cloneData(config.queue),
      posts: config.posts.map((post) => post.trim()).filter(Boolean),
      previews: cloneData(config.previews || {}),
      delay: cloneData(config.delay),
      safetyBreak: null,
      scheduledPublishTime: null,
      hasImage: Boolean(config.imageFile),
      hasVideo: Boolean(config.videoFile),
      currentPostIndex: randomInteger(0, config.posts.map((post) => post.trim()).filter(Boolean).length - 1),
      startedAt: Date.now()
    };
    this.log("info", `Bắt đầu chiến dịch với ${this.state.queue.length} nhóm.`);
    await this.emitState();
    const runId = ++this.runId;
    this.runPromise = this.runLoop(runId);
    return this.runPromise;
  }

  async restore(snapshot, { imageFile = null, videoFile = null } = {}) {
    if (!snapshot || !Array.isArray(snapshot.queue)) return false;
    this.stopRequested = false;
    this.imageFile = imageFile;
    this.videoFile = videoFile;
    const restoredResults = Array.isArray(snapshot.results) ? snapshot.results : [];
    const legacyPendingCount = restoredResults.filter((record) => record?.success && record?.pendingApproval).length;
    const hasPendingCount = Number.isFinite(Number(snapshot.pendingCount));
    const restoredPendingCount = hasPendingCount
      ? Math.max(0, Number(snapshot.pendingCount) || 0)
      : legacyPendingCount;
    const restoredSuccessCount = hasPendingCount
      ? Math.max(0, Number(snapshot.successCount) || 0)
      : Math.max(0, (Number(snapshot.successCount) || 0) - legacyPendingCount);
    this.state = {
      ...emptyState(),
      ...cloneData(snapshot),
      version: 3,
      status: [RUN_STATUS.COMPLETED, RUN_STATUS.STOPPED, RUN_STATUS.IDLE].includes(snapshot.status)
        ? snapshot.status
        : RUN_STATUS.PAUSED,
      safetyBreak: null,
      scheduledPublishTime: null,
      pendingDelayMs: snapshot.pendingDelayKind === "break" ? 0 : snapshot.pendingDelayMs,
      pendingDelayKind: snapshot.pendingDelayKind === "break" ? null : snapshot.pendingDelayKind,
      hasImage: Boolean(snapshot.hasImage),
      hasVideo: Boolean(snapshot.hasVideo),
      successCount: restoredSuccessCount,
      pendingCount: restoredPendingCount
    };
    for (const legacyKey of [
      "commentAfterPosting",
      "commentText",
      "commentDelayMs",
      "commentSummary",
      "currentCommentIndex",
      "commentsFinishedAt",
      "commentStoppedReason"
    ]) {
      delete this.state[legacyKey];
    }
    for (const record of this.state.results) {
      for (const legacyKey of [
        "commentStatus",
        "commentId",
        "commentErrorCode",
        "commentErrorMessage",
        "commentDuplicateGroupId",
        "commentDuplicateUrl",
        "commentCheckedAt",
        "commentedAt"
      ]) {
        delete record[legacyKey];
      }
    }
    if (this.state.hasImage && !this.imageFile) {
      this.log("warning", "Trạng thái có ảnh nhưng tệp ảnh chưa được khôi phục; cần chọn lại ảnh trước khi tiếp tục.");
    }
    if (this.state.hasVideo && !this.videoFile) {
      this.log("warning", "Trạng thái có video nhưng tệp video chưa được khôi phục; cần chọn lại video trước khi tiếp tục.");
    }
    if (snapshot.phase === "posting") {
      this.log("warning", "Tiện ích đã tải lại khi một bài đang được gửi. Tiếp tục có thể gửi lại nhóm hiện tại.");
    } else if (![RUN_STATUS.COMPLETED, RUN_STATUS.STOPPED, RUN_STATUS.IDLE].includes(snapshot.status)) {
      this.log("info", "Đã khôi phục chiến dịch ở trạng thái tạm dừng.");
    }
    await this.emitState();
    return true;
  }

  async resumeRestored() {
    if (this.runPromise) return this.resume();
    if (this.state.status !== RUN_STATUS.PAUSED) return;
    if (this.state.hasImage && !this.imageFile) {
      throw new Error("Cần chọn lại ảnh trước khi tiếp tục chiến dịch.");
    }
    if (this.state.hasVideo && !this.videoFile) {
      throw new Error("Cần chọn lại video trước khi tiếp tục chiến dịch.");
    }
    this.stopRequested = false;
    this.state.status = RUN_STATUS.RUNNING;
    this.log("info", "Tiếp tục chiến dịch đã khôi phục.");
    await this.emitState();
    const runId = ++this.runId;
    this.runPromise = this.runLoop(runId);
    return this.runPromise;
  }

  async pause(auto = false) {
    if (![RUN_STATUS.RUNNING, RUN_STATUS.WAITING].includes(this.state.status)) return;
    this.state.status = RUN_STATUS.PAUSED;
    this.log(auto ? "warning" : "info", auto
      ? `Tự động tạm dừng sau ${AUTO_PAUSE_FAILURES} lần lỗi liên tiếp.`
      : "Đã tạm dừng chiến dịch.");
    this.interruptActiveTimer();
    await this.emitState();
  }

  async resume() {
    if (this.state.status !== RUN_STATUS.PAUSED) return;
    this.state.status = RUN_STATUS.RUNNING;
    this.log("info", "Đã tiếp tục chiến dịch.");
    const resolver = this.resumeResolver;
    this.resumeResolver = null;
    resolver?.();
    await this.emitState();
  }

  async stop(reason = "Người dùng đã dừng chiến dịch.") {
    if ([RUN_STATUS.IDLE, RUN_STATUS.COMPLETED, RUN_STATUS.STOPPED].includes(this.state.status)) return;
    this.stopRequested = true;
    await this.api?.abortActiveVideo?.();
    this.state.status = RUN_STATUS.STOPPED;
    this.state.phase = "stopped";
    this.state.stoppedReason = reason;
    this.state.finishedAt = Date.now();
    this.interruptActiveTimer();
    const resolver = this.resumeResolver;
    this.resumeResolver = null;
    resolver?.();
    this.log("warning", reason);
    await this.emitState();
  }

  async reset() {
    await this.stop("Đã đặt lại chiến dịch.");
    this.runId += 1;
    this.imageFile = null;
    this.videoFile = null;
    this.state = emptyState();
    this.runPromise = null;
    this.interruptActiveTimer();
    await this.emitState();
  }

  interruptActiveTimer() {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    const resolver = this.activeTimerResolver;
    this.activeTimerResolver = null;
    resolver?.();
  }

  async waitWhilePaused(runId = this.runId) {
    while (this.state.status === RUN_STATUS.PAUSED && !this.stopRequested && this.runId === runId) {
      await new Promise((resolve) => {
        this.resumeResolver = resolve;
      });
    }
  }

  async sleep(ms) {
    await new Promise((resolve) => {
      this.activeTimerResolver = resolve;
      this.activeTimer = setTimeout(() => {
        this.activeTimer = null;
        this.activeTimerResolver = null;
        resolve();
      }, ms);
    });
  }

  async countdown(milliseconds, kind, groupName = "", runId = this.runId) {
    let remaining = Math.max(0, milliseconds);
    this.state.pendingDelayKind = kind;
    while (remaining > 0 && !this.stopRequested && this.runId === runId) {
      if (this.state.status === RUN_STATUS.PAUSED) {
        this.state.pendingDelayMs = remaining;
        await this.emitState();
        if (this.runId !== runId) return;
        await this.waitWhilePaused(runId);
        continue;
      }
      this.state.status = RUN_STATUS.WAITING;
      this.state.phase = kind;
      this.state.pendingDelayMs = remaining;
      await this.emitState();
      if (this.runId !== runId) return;
      const slice = Math.min(1000, remaining);
      const started = Date.now();
      await this.sleep(slice);
      if (this.state.status !== RUN_STATUS.PAUSED) {
        remaining = Math.max(0, remaining - Math.max(1, Date.now() - started));
      }
      this.onProgress?.({ ...this.snapshot(), countdownGroupName: groupName });
    }
    this.state.pendingDelayMs = 0;
    this.state.pendingDelayKind = null;
    if (this.runId !== runId) return;
    if (!this.stopRequested && this.state.status !== RUN_STATUS.PAUSED) {
      this.state.status = RUN_STATUS.RUNNING;
      this.state.phase = "ready";
      await this.emitState();
    }
  }

  async publishOnce(group, message, preview) {
    return this.api.publish(group.id, message, {
      imageFile: this.imageFile,
      videoFile: this.videoFile,
      preview,
      scheduledPublishTime: null,
      verifyApproval: true
    });
  }

  async sendWithRetry(group, message, preview, runId) {
    let result;
    let classification = null;
    try {
      result = await this.publishOnce(group, message, preview);
    } catch (error) {
      result = { success: false, url: null, raw: null, rawText: "", thrownError: error };
    }
    if (this.runId !== runId) return { result, classification: null };
    if (result.success) return { result, classification: null };

    classification = result.thrownError
      ? classifyThrownPublishError(result.thrownError)
      : classifyFacebookError(result.raw, result.rawText);

    if (classification.type === "TOKEN_EXPIRED" && classification.freshToken) {
      this.api.setToken(classification.freshToken);
      this.log("info", classification.logMessage);
      try {
        result = await this.publishOnce(group, message, preview);
      } catch (error) {
        result = { success: false, url: null, raw: null, rawText: "", thrownError: error };
      }
      if (this.runId !== runId) return { result, classification: null };
      if (result.success) return { result, classification: null };
      classification = result.thrownError
        ? { ...classification, type: "NETWORK_OR_UPLOAD_ERROR", logMessage: result.thrownError.message, shouldRetry: false }
        : classifyFacebookError(result.raw, result.rawText);
      return { result, classification };
    }

    if (classification.shouldRetry) {
      this.log("warning", `${classification.logMessage} Thử lại sau 8 giây.`, { groupId: group.id });
      await this.countdown(RETRY_DELAY_MS, "retry", group.name, runId);
      if (this.stopRequested || this.runId !== runId) return { result, classification };
      try {
        result = await this.publishOnce(group, message, preview);
      } catch (error) {
        result = { success: false, url: null, raw: null, rawText: "", thrownError: error };
      }
      if (result.success) return { result, classification: null };
      classification = result.thrownError
        ? classifyThrownPublishError(result.thrownError, false)
        : classifyFacebookError(result.raw, result.rawText);
    }
    return { result, classification };
  }

  async runLoop(runId) {
    try {
      if (this.state.pendingDelayMs > 0) {
        const kind = this.state.pendingDelayKind || "delay";
        const nextGroup = this.state.queue[this.state.currentIndex]?.name || "";
        await this.countdown(this.state.pendingDelayMs, kind, nextGroup, runId);
      }

      while (this.state.currentIndex < this.state.queue.length && !this.stopRequested && this.runId === runId) {
        await this.waitWhilePaused(runId);
        if (this.stopRequested || this.runId !== runId) break;

        const group = this.state.queue[this.state.currentIndex];
        if (this.state.skipList.includes(group.id)) {
          this.log("warning", `Bỏ qua ${group.name}: nhóm đã nằm trong danh sách bỏ qua của phiên.`);
          this.state.failCount += 1;
          this.state.currentIndex += 1;
          await this.emitState();
          continue;
        }

        const postIndex = Math.min(this.state.currentPostIndex, this.state.posts.length - 1);
        const message = this.state.posts[postIndex];
        const preview = this.state.previews[String(postIndex)] || null;
        this.state.status = RUN_STATUS.RUNNING;
        this.state.phase = "posting";
        await this.emitState();
        this.log("info", `Đang đăng vào ${group.name}.`, { groupId: group.id, postNumber: postIndex + 1 });

        const outcome = await this.sendWithRetry(group, message, preview, runId);
        if (this.stopRequested || this.runId !== runId) break;
        const { result, classification } = outcome;
        const succeeded = Boolean(result?.success);
        const url = succeeded ? exactFacebookPostUrl(result?.url) : null;
        const record = {
          groupId: group.id,
          groupName: group.name,
          postNumber: postIndex + 1,
          message,
          url,
          success: succeeded,
          pendingApproval: succeeded && (
            Boolean(result?.pendingApproval)
            || result?.canComment === false
            || Boolean(url?.includes("/pending_posts/"))
          ),
          canComment: succeeded && typeof result?.canComment === "boolean" ? result.canComment : null,
          approvalVerified: succeeded && Boolean(result?.approvalVerified || typeof result?.canComment === "boolean"),
          approvalSource: succeeded ? result?.approvalSource || null : null,
          storyId: succeeded ? result?.storyId || null : null,
          postId: succeeded ? result?.postId || null : null,
          feedbackId: succeeded ? result?.feedbackId || null : null,
          errorType: succeeded ? null : classification?.type || "UNKNOWN",
          errorMessage: succeeded ? null : classification?.logMessage || "Đăng bài thất bại.",
          time: Date.now()
        };

        if (succeeded) {
          if (record.pendingApproval) this.state.pendingCount += 1;
          else this.state.successCount += 1;
          this.state.consecutiveFailures = 0;
          this.log("success", record.pendingApproval
            ? `Đã gửi vào ${group.name}; bài bị giữ spam hoặc chờ admin duyệt.`
            : record.canComment === true
              ? `Bài trong ${group.name} đã được duyệt.`
              : `Đăng thành công vào ${group.name}.`, { url });
          if (this.state.posts.length > 1) {
            this.state.currentPostIndex = randomInteger(0, this.state.posts.length - 1);
          }
        } else {
          this.state.failCount += 1;
          this.state.consecutiveFailures += 1;
          this.log(classification?.shouldWarn ? "warning" : "error", record.errorMessage, { groupId: group.id });
          if (classification?.shouldSkip && !this.state.skipList.includes(group.id)) {
            this.state.skipList.push(group.id);
          }
        }

        this.state.results.push(record);
        this.state.currentIndex += 1;
        this.state.phase = "recorded";
        this.onResult?.(record, this.snapshot());
        await this.emitState();

        if (!succeeded && classification?.shouldStop) {
          await this.stop(classification.logMessage);
          break;
        }
        if (!succeeded && classification?.shouldWarn) {
          this.log("warning", classification.logMessage);
        }
        if (this.state.consecutiveFailures >= AUTO_PAUSE_FAILURES) {
          this.state.consecutiveFailures = 0;
          await this.pause(true);
          await this.waitWhilePaused(runId);
          if (this.stopRequested || this.runId !== runId) break;
        }
        if (this.state.currentIndex >= this.state.queue.length) break;

        const seconds = calculateDelaySeconds(this.state.delay);
        this.log("info", `Bài tiếp theo sau ${formatDuration(seconds)}.`);
        await this.countdown(seconds * 1000, "delay", this.state.queue[this.state.currentIndex]?.name || "", runId);
      }

      if (this.runId !== runId) return;
      if (!this.stopRequested && this.state.currentIndex >= this.state.queue.length) {
        this.state.status = RUN_STATUS.COMPLETED;
        this.state.phase = "completed";
        this.state.finishedAt = Date.now();
        this.state.pendingDelayMs = 0;
        this.state.pendingDelayKind = null;
        this.log("success", `Hoàn tất: ${formatResultSummary(this.state)}.`);
        await this.emitState();
        this.onComplete?.(this.snapshot());
      } else if (this.stopRequested) {
        this.onComplete?.(this.snapshot());
      }
    } catch (error) {
      if (this.runId !== runId) return;
      this.log("error", `Chiến dịch dừng do lỗi: ${error.message || error}`);
      await this.stop(`Lỗi không mong đợi: ${error.message || error}`);
      this.onComplete?.(this.snapshot());
    } finally {
      if (this.runId === runId) {
        this.runPromise = null;
        this.interruptActiveTimer();
      }
    }
  }
}
