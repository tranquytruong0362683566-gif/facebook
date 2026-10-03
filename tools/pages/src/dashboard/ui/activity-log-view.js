export class ActivityLogView {
  constructor(elements) {
    this.elements = elements;
    this.logDisplayAfter = 0;
    this.renderedIds = [];
    this.clearedIds = new Set();
  }

  clearDisplayedLogs() {
    this.renderedIds.forEach((id) => this.clearedIds.add(id));
    this.logDisplayAfter = Date.now();
    this.render([]);
  }

  appendLog(entry) {
    if (this.clearedIds.has(entry.id) || new Date(entry.at).getTime() < this.logDisplayAfter
      || this.renderedIds.includes(entry.id)) return;
    if (this.elements.logList.querySelector(".empty-state")) {
      this.elements.logList.textContent = "";
    }
    const row = document.createElement("div");
    row.className = "log-entry " + (entry.level || "");
    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString("vi-VN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const message = document.createElement("span");
    message.textContent = entry.message;
    row.append(time, message);
    this.elements.logList.appendChild(row);
    this.renderedIds.push(entry.id);
    this.elements.logList.scrollTop = this.elements.logList.scrollHeight;
  }

  render(logs = []) {
    const visible = logs.filter((entry) => !this.clearedIds.has(entry.id)
      && new Date(entry.at).getTime() >= this.logDisplayAfter);
    // Upload percentages change frequently; do not rebuild or scroll the log
    // unless its entries actually change.
    if (visible.length && visible.length === this.renderedIds.length
      && visible.every((entry, index) => entry.id === this.renderedIds[index])) return;
    this.renderedIds = [];
    this.elements.logList.textContent = "";
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Chưa có hoạt động.";
      this.elements.logList.appendChild(empty);
      return;
    }
    visible.forEach((entry) => this.appendLog(entry));
  }
}
