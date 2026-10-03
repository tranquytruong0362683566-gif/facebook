import { LIMITS, SUPPORTED_VIDEO_EXTENSIONS } from "../../shared/constants.js";

function extensionFromName(fileName) {
  return String(fileName || "").split(".").pop().toLowerCase();
}

export function titleFromFileName(fileName) {
  return String(fileName || "Video")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export function videoFingerprint(file) {
  return [
    String(file?.name || ""),
    Math.max(0, Number(file?.size) || 0),
    Math.max(0, Number(file?.lastModified) || 0)
  ].join("\u0000");
}

export async function validateVideoFile(file) {
  if (!(file instanceof File)) throw new TypeError("Tệp video không hợp lệ.");
  const extension = extensionFromName(file.name);
  if (!SUPPORTED_VIDEO_EXTENSIONS.includes(extension)) {
    throw new TypeError(file.name + ": chỉ hỗ trợ MP4, MOV hoặc WebM.");
  }
  if (file.size < LIMITS.MIN_VIDEO_BYTES) {
    throw new RangeError(file.name + ": tệp quá nhỏ hoặc đã hỏng.");
  }
  if (file.size > LIMITS.MAX_VIDEO_BYTES) {
    throw new RangeError(file.name + ": vượt quá giới hạn 4 GB.");
  }

  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isoMedia = header.length >= 8
    && String.fromCharCode(...header.slice(4, 8)) === "ftyp";
  const webm = header.length >= 4
    && header[0] === 0x1a
    && header[1] === 0x45
    && header[2] === 0xdf
    && header[3] === 0xa3;
  if (!isoMedia && !webm) {
    throw new TypeError(file.name + ": nội dung tệp không khớp định dạng video.");
  }
}
