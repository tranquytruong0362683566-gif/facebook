// Draft edits must not delete files still needed by a saved publishing job.
export function collectRetainedVideoIds(queue = [], templates = [], snapshot = null) {
  const ids = new Set();
  for (const item of queue) if (item?.id) ids.add(item.id);
  for (const template of templates) {
    for (const item of template.videos || []) if (item?.id) ids.add(item.id);
  }
  for (const job of snapshot?.jobs || []) {
    if (job.videoLocalId && !job.result?.videoId && !["succeeded", "cancelled"].includes(job.status)) {
      ids.add(job.videoLocalId);
    }
  }
  return [...ids];
}
