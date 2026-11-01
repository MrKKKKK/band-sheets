/** 222.4 → "3:42"; NaN / negative → "0:00". */
export function formatClock(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 222.4 → "3 分 42 秒", 42 → "42 秒". */
export function formatDurationJa(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

/** Bytes → "38.2 MB" / "512 KB" (decimal units, like the OS file dialogs). */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
