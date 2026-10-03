function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[=+\-@]/.test(text.trimStart()) ? "'" + text : text;
  return '"' + safeText.replace(/"/g, '""') + '"';
}

function commentStatus(job) {
  if (!job.commentText) return "disabled";
  if (job.result?.comment?.success) return "succeeded";
  if (job.result?.comment?.error) return "failed";
  return "pending";
}

export function exportRunCsv(snapshot) {
  if (!snapshot?.jobs?.length) return false;
  const rows = [[
    "video",
    "page_id",
    "page_name",
    "status",
    "facebook_video_id",
    "url",
    "comment_status",
    "comment_id",
    "comment_error",
    "error_code",
    "error_message",
    "unknown_outcome",
    "title",
    "caption",
    "ai_model",
    "batch_number",
    "batch_id",
    "comment_text",
    "comment_ai_model",
    "media_type",
    "facebook_photo_id",
    "facebook_post_id"
  ]];

  for (const job of snapshot.jobs) {
    const resultError = job.error || job.result?.finalizationError;
    rows.push([
      job.fileName,
      job.pageId,
      job.pageName,
      job.status,
      job.result?.videoId || "",
      job.result?.url || "",
      commentStatus(job),
      job.result?.comment?.commentId || "",
      job.result?.comment?.error?.message || "",
      resultError?.code || "",
      resultError?.message || "",
      resultError?.unknownOutcome ? "true" : "false",
      job.title || "",
      job.caption || "",
      job.aiModel || "",
      job.batchNumber || 1,
      job.batchId || "",
      job.commentText || "",
      job.commentAiModel || "",
      job.mediaType || "video",
      job.result?.photoId || "",
      job.result?.postId || ""
    ]);
  }

  const csv = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "ket-qua-dang-bai-page-" + new Date().toISOString().slice(0, 10) + ".csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
  return true;
}
