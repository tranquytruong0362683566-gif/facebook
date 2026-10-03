import { postingSpeedLabel } from "../data/posting-speed.js";

function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("vi-VN");
}

function summarizeContent(template) {
  if (template.settings.aiEnabled) {
    return template.settings.useVideoTitleAsContent ? "AI viết từ tên video" : "AI viết từ nội dung nhập thủ công";
  }
  if (template.settings.useVideoTitleAsContent) return "Nội dung: dùng tên video";
  const content = template.settings.postContent.trim().replace(/\s+/g, " ");
  return content ? content.slice(0, 90) : "Không có nội dung bài viết";
}

function createMeta(text, className = "") {
  const node = document.createElement("span");
  node.className = "template-meta" + (className ? " " + className : "");
  node.textContent = text;
  return node;
}

export class ContentTemplatesView {
  constructor(elements) {
    this.elements = elements;
    this.editingTemplateId = null;
  }

  render(templates, { disabled = false } = {}) {
    const list = this.elements.templateList;
    list.textContent = "";
    this.elements.templateCount.textContent = formatNumber(templates.length) + " mẫu";
    this.elements.addTemplateButton.disabled = disabled;

    if (!templates.length) {
      const empty = document.createElement("div");
      empty.className = "template-empty";
      const title = document.createElement("strong");
      title.textContent = "Chưa có mẫu";
      const description = document.createElement("span");
      description.textContent = "Thiết lập nội dung rồi bấm Thêm mẫu.";
      empty.append(title, description);
      list.appendChild(empty);
      return;
    }

    for (const template of templates) {
      const card = document.createElement("article");
      card.className = "template-card";
      card.dataset.templateId = template.id;

      const applyButton = document.createElement("button");
      applyButton.type = "button";
      applyButton.className = "template-apply";
      applyButton.dataset.templateAction = "apply";
      applyButton.dataset.templateId = template.id;
      applyButton.disabled = disabled;
      applyButton.setAttribute("aria-label", "Áp dụng mẫu " + template.name);

      const heading = document.createElement("span");
      heading.className = "template-card-heading";
      const name = document.createElement("strong");
      name.textContent = template.name;
      const hint = document.createElement("span");
      hint.textContent = "Áp dụng";
      heading.append(name, hint);

      const preview = document.createElement("span");
      preview.className = "template-preview";
      preview.textContent = summarizeContent(template);

      const meta = document.createElement("span");
      meta.className = "template-meta-row";
      const speed = postingSpeedLabel(template.settings.uploadConcurrency);
      meta.append(
        createMeta(formatNumber(template.videos.length) + (template.mediaType === "photo" ? " ảnh" : " video")),
        ...(template.mediaType === "photo" ? [] : [createMeta(speed)]),
        createMeta(template.settings.commentEnabled
          ? (template.settings.commentAiEnabled ? "Bình luận AI" : "Có bình luận") : "Không bình luận")
      );
      applyButton.append(heading, preview, meta);

      const actions = document.createElement("div");
      actions.className = "template-actions";
      const update = document.createElement("button");
      update.type = "button";
      update.className = "button compact ghost";
      update.dataset.templateAction = "update";
      update.dataset.templateId = template.id;
      update.disabled = disabled;
      update.textContent = "Cập nhật";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button compact danger";
      remove.dataset.templateAction = "delete";
      remove.dataset.templateId = template.id;
      remove.disabled = disabled;
      remove.textContent = "Xóa";
      actions.append(update, remove);
      card.append(applyButton, actions);
      list.appendChild(card);
    }
  }

  setDisabled(disabled) {
    this.elements.addTemplateButton.disabled = disabled;
    this.elements.templateList
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = disabled;
      });
  }

  openEditor({ template = null, videos = [], settings }) {
    this.editingTemplateId = template?.id || null;
    this.elements.templateDialogTitle.textContent = template ? "Cập nhật mẫu" : "Thêm mẫu mới";
    this.elements.templateName.value = template?.name || "";
    this.elements.templateDialogError.textContent = "";
    const comment = settings.commentEnabled ? "có bình luận tự động" : "không bình luận";
    const videoNames = videos.slice(0, 2).map((video) => video.name).join(", ");
    const videoSummary = formatNumber(videos.length) + (settings.contentMode === "photos" ? " ảnh" : " video")
      + (videoNames ? " (" + videoNames + (videos.length > 2 ? ", …" : "") + ")" : "");
    this.elements.templateSnapshotSummary.textContent = videoSummary
      + " · " + comment;
    if (!this.elements.templateDialog.open) this.elements.templateDialog.showModal();
    requestAnimationFrame(() => {
      this.elements.templateName.focus();
      this.elements.templateName.select();
    });
  }

  closeEditor() {
    this.editingTemplateId = null;
    this.elements.templateDialogError.textContent = "";
    if (this.elements.templateDialog.open) this.elements.templateDialog.close();
  }

  setError(message) {
    this.elements.templateDialogError.textContent = message || "";
  }

  setSaving(saving) {
    this.elements.templateName.disabled = saving;
    this.elements.cancelTemplateButton.disabled = saving;
    this.elements.saveTemplateButton.disabled = saving;
    this.elements.saveTemplateButton.textContent = saving ? "Đang lưu…" : "Lưu mẫu";
  }
}
