// Limit selected files to formats accepted by the photo publishing flow.
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/gif,.jpg,.jpeg,.png,.gif";
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export async function validatePhotoFile(file) {
  if (!(file instanceof File)) throw new TypeError("Tệp ảnh không hợp lệ.");
  const extension = file.name.split(".").pop().toLowerCase();
  const formats = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif" };
  const format = formats[extension];
  if (!format) throw new TypeError(file.name + ": chỉ hỗ trợ ảnh JPG, PNG hoặc GIF.");
  if (file.type && file.type !== "image/" + format) {
    throw new TypeError(file.name + ": loại tệp không khớp định dạng ảnh.");
  }
  if (!file.size) throw new RangeError(file.name + ": tệp ảnh đang trống.");
  if (file.size > MAX_PHOTO_BYTES) throw new RangeError(file.name + ": ảnh vượt quá 10 MB.");
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const gif = ["GIF87a", "GIF89a"].includes(String.fromCharCode(...header.slice(0, 6)));
  if (!({ jpeg, png, gif })[format]) {
    throw new TypeError(file.name + ": nội dung tệp không khớp định dạng ảnh.");
  }
}
