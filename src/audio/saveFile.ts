/** Save a Blob to the user's PC under `name` (object URL + `<a download>`). */
export interface SaveFileEnv {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createAnchor: () => HTMLAnchorElement;
  /** Defers the revoke so the browser has started the download. */
  later: (fn: () => void) => void;
}

const defaultEnv: SaveFileEnv = {
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
  createAnchor: () => document.createElement('a'),
  later: (fn) => {
    setTimeout(fn, 0);
  },
};

export function saveFile(
  blob: Blob,
  name: string,
  env: SaveFileEnv = defaultEnv,
): void {
  const url = env.createObjectURL(blob);
  try {
    const a = env.createAnchor();
    a.href = url;
    a.download = name;
    a.click();
  } finally {
    env.later(() => env.revokeObjectURL(url));
  }
}
