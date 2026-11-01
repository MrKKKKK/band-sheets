/**
 * The length of a picked audio file BEFORE it is decoded (S1 shows it and stops files over 10 minutes early,
 * plan section 6.2): a WAV from its header, anything else from an <audio> element's metadata on a local object
 * URL (nothing is sent anywhere; the URL is revoked at once). null = unknown (the decode decides later).
 */
import { readWavHeader, wavDurationSec } from './audioFile';

/** The part of HTMLAudioElement used here (a fake in unit tests). */
export interface MetadataElement {
  preload: string;
  src: string;
  readonly duration: number;
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
  removeAttribute(name: string): void;
  load(): void;
}

export interface ProbeOptions {
  createElement?: () => MetadataElement;
  createUrl?: (b: Blob) => string;
  revokeUrl?: (url: string) => void;
  /** Give up on the metadata after this many ms (default 5000). */
  timeoutMs?: number;
}

const HEAD_BYTES = 1 << 16;

async function wavDuration(file: Blob): Promise<number | null> {
  try {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    const h = readWavHeader(head, file.size);
    return h ? wavDurationSec(h) : null;
  } catch {
    return null;
  }
}

function metadataDuration(
  file: Blob,
  opts: ProbeOptions,
): Promise<number | null> {
  const createElement =
    opts.createElement ??
    (() => document.createElement('audio') as MetadataElement);
  const createUrl = opts.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = opts.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));
  let el: MetadataElement;
  let url: string;
  try {
    el = createElement();
    url = createUrl(file);
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (d: number | null) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute('src');
      try {
        el.load();
      } catch {
        // ignore
      }
      revokeUrl(url);
      resolve(d);
    };
    el.onloadedmetadata = () =>
      done(
        Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
      );
    el.onerror = () => done(null);
    timer = setTimeout(() => done(null), opts.timeoutMs ?? 5000);
    el.preload = 'metadata';
    el.src = url;
  });
}

export async function probeDuration(
  file: Blob,
  opts: ProbeOptions = {},
): Promise<number | null> {
  return (await wavDuration(file)) ?? metadataDuration(file, opts);
}
