function normalizeScript(value: string | null | undefined) {
  return (value || "").replace(/\r\n/g, "\n").trim();
}

function countWords(value: string) {
  return value.split(/\s+/).filter(Boolean).length;
}

export function estimateScriptDurationSeconds(value: string | null | undefined) {
  const normalized = normalizeScript(value);
  if (!normalized) return null;
  const words = countWords(normalized);
  if (words === 0) return null;
  return Math.max(1, Math.round((words / 120) * 60));
}

export function formatEstimatedScriptDuration(value: string | null | undefined) {
  const seconds = estimateScriptDurationSeconds(value);
  if (!Number.isFinite(seconds)) return null;
  const safeSeconds = Math.max(1, Math.trunc(seconds ?? 0));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
