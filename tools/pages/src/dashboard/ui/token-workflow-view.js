const STEP_LABELS = Object.freeze({
  idle: "Chờ",
  active: "Đang xử lý",
  done: "Hoàn tất",
  warning: "Cần xác minh",
  error: "Có lỗi"
});

const PHASE_VIEWS = Object.freeze({
  idle: {
    title: "Kết nối tự động an toàn",
    message: "Hệ thống kiểm tra phiên, hỗ trợ xác minh và tự lấy token.",
    steps: ["idle", "idle", "idle"]
  },
  checking: {
    title: "Đang kiểm tra phiên Facebook",
    steps: ["active", "idle", "idle"]
  },
  opening: {
    title: "Cần xác minh tài khoản",
    steps: ["warning", "active", "idle"]
  },
  verifying: {
    title: "Đang chờ xác minh Ads Manager",
    steps: ["done", "active", "idle"]
  },
  retrying: {
    title: "Đang tự lấy lại token",
    steps: ["done", "done", "active"]
  },
  success: {
    title: "Kết nối thành công",
    steps: ["done", "done", "done"]
  },
  error: {
    title: "Chưa thể hoàn tất kết nối",
    steps: ["done", "done", "error"]
  }
});

export class TokenWorkflowView {
  constructor(elements) {
    this.elements = elements;
    this.loading = false;
    this.state = { phase: "idle" };
  }

  setStatus(message, type = "") {
    this.elements.tokenStatus.textContent = message;
    this.elements.tokenStatus.className = type || "muted";
  }

  setStepState(node, state) {
    if (!node) return;
    node.dataset.state = state;
    const status = node.querySelector(".workflow-step-status");
    if (status) status.textContent = STEP_LABELS[state] || state;
  }

  setLoading(loading) {
    this.loading = Boolean(loading);
    this.elements.tokenWorkflowCard?.classList.toggle("is-busy", this.loading);
    if (this.elements.retryTokenButton) {
      this.elements.retryTokenButton.textContent = this.loading
        ? "Thử lại ngay"
        : "Lấy lại token";
    }
  }

  render(nextState = { phase: "idle" }) {
    if (!this.elements.tokenWorkflowCard) return;
    this.state = nextState;
    const phase = PHASE_VIEWS[nextState.phase] ? nextState.phase : "idle";
    const view = PHASE_VIEWS[phase];
    this.elements.tokenWorkflowCard.dataset.phase = phase;
    this.elements.tokenWorkflowCard.setAttribute(
      "aria-busy",
      String(["checking", "opening", "verifying", "retrying"].includes(phase))
    );
    this.elements.tokenWorkflowTitle.textContent = view.title;
    this.elements.tokenWorkflowDescription.textContent = nextState.message || view.message || "";
    [
      this.elements.tokenStepSession,
      this.elements.tokenStepVerification,
      this.elements.tokenStepToken
    ].forEach((node, index) => this.setStepState(node, view.steps[index]));

    const showVerificationActions = ["opening", "verifying", "retrying", "error"]
      .includes(phase);
    this.elements.openAdsManagerButton.hidden = !showVerificationActions;
    this.elements.retryTokenButton.hidden = !["verifying", "error"].includes(phase);
    this.setLoading(this.loading);

    if (phase === "success") this.setStatus("Đã kết nối", "status-success");
    else if (phase === "error") this.setStatus("Cần thử lại", "validation-message");
    else if (phase === "idle") this.setStatus("Sẵn sàng", "muted");
    else this.setStatus("Đang xử lý", "status-working");
  }
}
