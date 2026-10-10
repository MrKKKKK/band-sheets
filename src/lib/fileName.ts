export const SONG_FILE_EXT = '.bandsheet';

const MAX_NAME_CHARS = 80;
const EMPTY_NAME = '無題の曲';

export function fileNameForTitle(title: string): string {
  const cleaned = title
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '_')
    .trim();
  // slice by code points so surrogate pairs are never split
  const cut = Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('').trim();
  return (cut === '' ? EMPTY_NAME : cut) + SONG_FILE_EXT;
}

export function copyTitle(title: string): string {
  return `${title} のコピー`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 「<曲名>（手元の版 10/6 15:12）」。時刻は端末のローカル時刻 */
export function localCopyTitle(title: string, at: Date): string {
  const stamp = `${at.getMonth() + 1}/${at.getDate()} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return `${title}（手元の版 ${stamp}）`;
}
