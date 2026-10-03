import { publishedObjectId } from "../data/posting-mode.js";
import { JOB_STATUS } from "../../shared/constants.js";

const ERROR_STATUSES = new Set([
  JOB_STATUS.FAILED,
  JOB_STATUS.INTERRUPTED,
  JOB_STATUS.CANCELLED
]);

const ACTIVE_UPLOAD_STATUSES = new Set([
  JOB_STATUS.GENERATING,
  JOB_STATUS.UPLOADING
]);

function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("vi-VN");
}

function timestampOf(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function stageLabel(job) {
  const labels = {
    pending: "Chờ luồng",
    page_delay: "Chờ bài tiếp theo",
    ai_writing: "Đang viết AI",
    ai_ready: "AI đã viết xong",
    ai_failed: "Chưa đăng · AI đã dừng/lỗi",
    processing_queued: "Chờ kiểm tra",
    processing_pending: "Chờ tiếp tục kiểm tra",
    processing_failed: "Xử lý lỗi",
    comment_pending: "Chờ tiếp tục bình luận",
    comment_wait: "Chờ bình luận",
    comment_ai_writing: "AI viết bình luận",
    commenting: "Đang bình luận",
    processing: "Xử lý",
    ready: "Sẵn sàng",
    accepted: "Đã nhận"
  };
  return labels[job.stage] || "Tải lên";
}

export function groupJobsByPage(jobs = []) {
  const pages = new Map();
  for (const job of jobs) {
    const pageId = String(job?.pageId || "");
    if (!pageId) continue;
    if (!pages.has(pageId)) {
      pages.set(pageId, {
        id: pageId,
        name: String(job.pageName || pageId),
        jobs: []
      });
    }
    pages.get(pageId).jobs.push(job);
  }
  return [...pages.values()];
}

export function videoResultTone(job) {
  if (job?.status === JOB_STATUS.SUCCEEDED) return "success";
  if (ERROR_STATUSES.has(job?.status)) return "error";
  return "pending";
}

function waitsForNormalTurn(pageId, snapshot) {
  if (snapshot?.speed?.mode !== "normal") return false;
  const jobs = snapshot.jobs || [];
  if (jobs.some((job) => job.pageId !== pageId
    && (ACTIVE_UPLOAD_STATUSES.has(job.status) || job.status === JOB_STATUS.PROCESSING))) return true;
  const order = [...new Set(jobs.map((job) => job.pageId))];
  const pending = new Set(jobs.filter((job) => job.status === JOB_STATUS.PENDING).map((job) => job.pageId));
  const start = Math.max(0, order.indexOf(snapshot.nextPageId));
  for (let offset = 0; offset < order.length; offset += 1) {
    const nextId = order[(start + offset) % order.length];
    if (pending.has(nextId)) return nextId !== pageId;
  }
  return false;
}

export function getPageProgress(page, snapshot, now = Date.now()) {
  const jobs = page?.jobs || [];
  const remaining = jobs.filter((job) => job.status !== JOB_STATUS.SUCCEEDED).length;
  const activeUpload = jobs.some((job) => (
    ACTIVE_UPLOAD_STATUSES.has(job.status) && !publishedObjectId(job.result)
  ));
  if (activeUpload) return { remaining, state: "active", nextAt: 0 };
  if (jobs.some((job) => job.status === JOB_STATUS.PROCESSING)) {
    return { remaining, state: "finalizing", nextAt: 0 };
  }

  const nextJob = jobs.find((job) => (
    job.status === JOB_STATUS.PENDING && !publishedObjectId(job.result)
  ));
  if (nextJob) {
    const lastVideoAt = timestampOf(snapshot?.pageLastVideoAt?.[page.id]);
    const nextAt = lastVideoAt
      ? lastVideoAt + (Math.max(0, Number(nextJob.delaySeconds) || 0) * 1_000)
      : 0;
    if (snapshot?.status === "paused") return { remaining, state: "paused", nextAt };
    if (snapshot?.status === "stopped") return { remaining, state: "stopped", nextAt: 0 };
    if (waitsForNormalTurn(page.id, snapshot)) return { remaining, state: "waiting_turn", nextAt: 0 };
    if (nextAt > now) return { remaining, state: "waiting", nextAt };
    return { remaining, state: "ready", nextAt: 0 };
  }

  const finalizing = jobs.some((job) => (
    job.status === JOB_STATUS.PROCESSING
    || (job.status === JOB_STATUS.PENDING && Boolean(publishedObjectId(job.result)))
  ));
  if (finalizing) return { remaining, state: "finalizing", nextAt: 0 };
  if (!remaining) return { remaining: 0, state: "done", nextAt: 0 };
  if (snapshot?.status === "stopped") return { remaining, state: "stopped", nextAt: 0 };
  return { remaining, state: "errors", nextAt: 0 };
}

export class RunResultsView {
  constructor(elements, statusLabels) {
    this.elements = elements;
    this.statusLabels = statusLabels;
    this.renderedRunId = null;
    this.openPageIds = new Set();
    this.countdownTimer = null;
  }

  reset() {
    this.renderedRunId = null;
    this.openPageIds.clear();
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  ensureCountdownTimer() {
    if (this.countdownTimer) return;
    this.countdownTimer = setInterval(() => this.updateCountdowns(), 1_000);
  }

  updateCountdowns(now = Date.now()) {
    for (const element of this.elements.pageProgressList?.querySelectorAll("[data-countdown-state]") || []) {
      const state = element.dataset.countdownState;
      const nextAt = Number(element.dataset.nextAt) || 0;
      if ((state === "waiting" || state === "paused") && nextAt > now) {
        const remaining = formatCountdown(nextAt - now);
        element.textContent = state === "paused"
          ? "Đã tạm dừng · còn " + remaining
          : "Bài tiếp theo sau " + remaining;
        continue;
      }
      if (state === "waiting") {
        element.dataset.countdownState = "ready";
        element.textContent = "Sẵn sàng đăng bài tiếp theo";
      } else if (state === "paused") {
        element.textContent = "Tiến trình đang tạm dừng";
      }
    }
  }

  nextVideoText(progress) {
    const labels = {
      active: "Đang đăng bài",
      ready: "Sẵn sàng đăng bài tiếp theo",
      waiting_turn: "Đăng Thường · chờ đến lượt Page",
      finalizing: "Đã tải xong · đang xử lý",
      done: "Đã đăng xong",
      stopped: "Tiến trình đã dừng",
      errors: "Không còn bài đang chờ"
    };
    if (progress.state === "waiting") {
      return "Bài tiếp theo sau " + formatCountdown(progress.nextAt - Date.now());
    }
    if (progress.state === "paused") {
      return progress.nextAt > Date.now()
        ? "Đã tạm dừng · còn " + formatCountdown(progress.nextAt - Date.now())
        : "Tiến trình đang tạm dừng";
    }
    return labels[progress.state] || "Đang chờ";
  }

  statusBlock(job) {
    const wrapper = document.createElement("div");
    wrapper.className = "page-video-status";
    const pill = document.createElement("span");
    pill.className = "status-text " + job.status;
    pill.textContent = this.statusLabels[job.status] || job.status;
    wrapper.appendChild(pill);

    if (job.result?.url) {
      const link = document.createElement("a");
      link.className = "result-link";
      link.href = job.result.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Mở bài";
      wrapper.appendChild(link);
    }

    const resultError = job.error || job.result?.finalizationError;
    if (resultError?.message) {
      const error = document.createElement("span");
      error.className = "result-error";
      error.textContent = resultError.message
        + (resultError.unknownOutcome ? " Trạng thái phía Facebook chưa xác định." : "");
      wrapper.appendChild(error);
    }
    return wrapper;
  }

  commentBlock(job) {
    const wrapper = document.createElement("div");
    wrapper.className = "page-video-comment";
    const label = document.createElement("span");
    label.className = "page-video-detail-label";
    label.textContent = "Bình luận";
    const value = document.createElement("span");
    if (!job.commentText) {
      value.textContent = "Không bật";
      value.className = "muted";
    } else if (job.result?.comment?.success) {
      value.textContent = "Đã bình luận";
      value.className = "comment-success";
    } else if (job.result?.comment?.error) {
      value.textContent = "Lỗi: " + job.result.comment.error.message;
      value.className = "comment-error";
    } else if (job.stage === "comment_ai_writing") {
      value.textContent = "AI đang viết lại…";
    } else if (["comment_pending", "comment_wait", "commenting"].includes(job.stage)) {
      value.textContent = job.stage === "commenting" ? "Đang gửi…" : "Chờ bình luận";
    } else {
      value.textContent = "Đang chờ đăng bài";
    }
    wrapper.append(label, value);

    if (job.commentAiGeneratedAt) {
      const details = document.createElement("details");
      details.className = "result-ai-content";
      const summary = document.createElement("summary");
      summary.textContent = "Xem bình luận AI";
      const text = document.createElement("p");
      text.textContent = job.commentText;
      details.append(summary, text);
      wrapper.appendChild(details);
    }
    return wrapper;
  }

  videoInfo(job) {
    const wrapper = document.createElement("div");
    wrapper.className = "page-video-info";
    const name = document.createElement("strong");
    name.textContent = job.fileName;
    const meta = document.createElement("span");
    meta.textContent = (job.mediaType === "photo" ? "Ảnh · " : "REELS · ") + "Đợt " + (job.batchNumber || 1) + " · "
      + Math.max(0, Math.min(100, Number(job.progress) || 0)) + "% · " + stageLabel(job);
    wrapper.append(name, meta);

    if (job.aiGeneratedAt) {
      const details = document.createElement("details");
      details.className = "result-ai-content";
      const summary = document.createElement("summary");
      summary.textContent = "Xem tiêu đề và nội dung AI";
      const title = document.createElement("strong");
      title.className = "result-ai-title";
      title.textContent = job.title;
      const caption = document.createElement("p");
      caption.textContent = job.caption;
      details.append(summary, title, caption);
      wrapper.appendChild(details);
    }
    return wrapper;
  }

  appendVideoItem(container, job) {
    const item = document.createElement("article");
    item.className = "page-video-item is-" + videoResultTone(job);
    item.append(this.videoInfo(job), this.commentBlock(job), this.statusBlock(job));
    container.appendChild(item);
  }

  renderPageVideos(container, jobs) {
    container.textContent = "";
    jobs.forEach((job) => this.appendVideoItem(container, job));
    container.dataset.rendered = "true";
  }

  appendPageGroup(page, snapshot) {
    const progress = getPageProgress(page, snapshot);
    const details = document.createElement("details");
    details.className = "page-progress-card";
    details.dataset.pageId = page.id;
    details.open = this.openPageIds.has(page.id);

    const summary = document.createElement("summary");
    summary.className = "page-progress-summary";
    const name = document.createElement("strong");
    name.className = "page-progress-name";
    name.textContent = page.name;
    const countdown = document.createElement("span");
    countdown.className = "page-next-video";
    countdown.dataset.countdownState = progress.state;
    countdown.dataset.nextAt = String(progress.nextAt || 0);
    countdown.textContent = this.nextVideoText(progress);
    const remaining = document.createElement("span");
    remaining.className = "page-video-remaining";
    const amount = document.createElement("strong");
    amount.textContent = formatNumber(progress.remaining);
    remaining.append(amount, document.createTextNode(" bài còn lại"));
    summary.append(name, countdown, remaining);

    const list = document.createElement("div");
    list.className = "page-video-list";
    if (details.open) this.renderPageVideos(list, page.jobs);
    details.append(summary, list);
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openPageIds.add(page.id);
        if (list.dataset.rendered !== "true") this.renderPageVideos(list, page.jobs);
      } else {
        this.openPageIds.delete(page.id);
      }
    });
    this.elements.pageProgressList.appendChild(details);
  }

  renderEmptyResults() {
    this.elements.pageProgressList.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state page-progress-empty";
    empty.textContent = "Chưa có tiến trình.";
    this.elements.pageProgressList.appendChild(empty);
    this.elements.totalStat.textContent = "0";
    this.elements.successStat.textContent = "0";
    this.elements.failedStat.textContent = "0";
    this.elements.pendingStat.textContent = "0";
    this.elements.overallProgress.value = 0;
  }

  renderResults(snapshot) {
    const jobs = snapshot?.jobs || [];
    if (snapshot?.id && snapshot.id !== this.renderedRunId) {
      this.renderedRunId = snapshot.id;
      this.openPageIds.clear();
    } else if (!snapshot?.id) {
      this.reset();
    }
    if (!jobs.length) {
      this.renderEmptyResults();
      return;
    }

    const pages = groupJobsByPage(jobs);
    const pageIds = new Set(pages.map((page) => page.id));
    for (const pageId of this.openPageIds) {
      if (!pageIds.has(pageId)) this.openPageIds.delete(pageId);
    }
    this.elements.pageProgressList.textContent = "";
    pages.forEach((page) => this.appendPageGroup(page, snapshot));

    const succeeded = jobs.filter((job) => job.status === JOB_STATUS.SUCCEEDED).length;
    const failed = jobs.filter((job) => ERROR_STATUSES.has(job.status)).length;
    const terminal = succeeded + failed;
    const pending = jobs.length - terminal;
    this.elements.totalStat.textContent = formatNumber(jobs.length);
    this.elements.successStat.textContent = formatNumber(succeeded);
    this.elements.failedStat.textContent = formatNumber(failed);
    this.elements.pendingStat.textContent = formatNumber(pending);
    this.elements.overallProgress.value = Math.round((terminal / jobs.length) * 100);
    this.updateCountdowns();
    this.ensureCountdownTimer();
  }

  render(snapshot) {
    this.renderResults(snapshot);
  }
}
