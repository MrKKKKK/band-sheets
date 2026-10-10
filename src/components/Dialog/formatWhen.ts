const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 「今日 15:08」/「10/5 15:08」. Invalid input is returned as-is so a bad
 * timestamp never throws inside a dialog.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? `今日 ${time}`
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
