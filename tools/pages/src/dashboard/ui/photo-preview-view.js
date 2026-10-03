import { getVideo } from "../data/video-database.js";

export class PhotoPreviewView {
  constructor(container) {
    this.container = container;
    this.urls = [];
    this.revision = 0;
    this.key = null;
  }

  clear() {
    this.revision += 1;
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls = [];
    this.container.replaceChildren();
  }

  async render(queue, { enabled, disabled }) {
    this.disabled = disabled;
    const key = enabled ? queue.map((item) => item.id).join(",") : "";
    if (key === this.key) {
      this.container.querySelectorAll("button").forEach((button) => { button.disabled = disabled; });
      return;
    }
    this.key = key;
    this.clear();
    this.container.hidden = !enabled || !queue.length;
    if (this.container.hidden) return;
    const revision = this.revision;
    for (const item of queue.slice(0, 24)) {
      if (revision !== this.revision) return;
      const card = document.createElement("figure");
      card.className = "photo-preview-card";
      const img = document.createElement("img");
      img.alt = item.name;
      img.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = item.name;
      caption.title = item.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "photo-remove";
      remove.dataset.removePhoto = item.id;
      remove.setAttribute("aria-label", "Bỏ ảnh " + item.name);
      remove.textContent = "×";
      remove.disabled = this.disabled;
      card.append(img, caption, remove);
      this.container.appendChild(card);
      try {
        const file = await getVideo(item.id);
        if (revision !== this.revision) return;
        if (file) {
          const url = URL.createObjectURL(file);
          this.urls.push(url);
          img.src = url;
        }
      } catch {
        img.alt = "Không xem trước được: " + item.name;
      }
    }
    if (queue.length > 24 && revision === this.revision) {
      const more = document.createElement("p");
      more.className = "photo-preview-more";
      more.textContent = "Và " + (queue.length - 24).toLocaleString("vi-VN") + " ảnh khác đã chọn.";
      this.container.appendChild(more);
    }
  }
}
