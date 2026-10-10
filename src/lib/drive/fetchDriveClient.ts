/**
 * The real `DriveClient`: Drive API v3 over `fetch` (no gapi), docs/m7-plan.md
 * decision 2. Verified against Google's docs in docs/m7-drive-findings.md.
 *
 * Errors become `DriveError`: 401 → auth, 404 → notFound, 429 and 403 with
 * reason rateLimitExceeded/userRateLimitExceeded → rateLimit, 5xx → server,
 * `fetch` rejecting → network, anything else → other. rateLimit and server
 * errors are retried once after 1 s — except a 5xx on `create`, which may
 * already have created the file (retrying could make a duplicate).
 */

import type { DriveFileMeta, DriveErrorKind } from '../syncTypes';
import {
  DriveError,
  FOLDER_MIME_TYPE,
  SONG_MIME_TYPE,
  type DriveClient,
} from './driveClient';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_API =
  'https://www.googleapis.com/upload/drive/v3/files';
export const META_FIELDS = 'id,name,version,modifiedTime,appProperties';
export const RETRY_DELAY_MS = 1000;

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

/** Quotes a string literal for a Drive `q` (escapes `\` and `'`). */
export function quoteQ(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function url(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

async function errorReason(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    const errors = (body as { error?: { errors?: { reason?: unknown }[] } })
      ?.error?.errors;
    const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}

export async function errorFromResponse(res: Response): Promise<DriveError> {
  const status = res.status;
  let kind: DriveErrorKind = 'other';
  if (status === 401) kind = 'auth';
  else if (status === 404) kind = 'notFound';
  else if (status === 429) kind = 'rateLimit';
  else if (status >= 500) kind = 'server';
  else if (status === 403) {
    const reason = await errorReason(res);
    if (reason && RATE_LIMIT_REASONS.has(reason)) kind = 'rateLimit';
  }
  return new DriveError(kind, status);
}

function toMeta(raw: unknown): DriveFileMeta {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.version !== 'string' ||
    typeof r.modifiedTime !== 'string'
  ) {
    throw new DriveError('other', undefined, 'Unexpected Drive response');
  }
  const meta: DriveFileMeta = {
    id: r.id,
    name: r.name,
    version: r.version,
    modifiedTime: r.modifiedTime,
  };
  if (r.appProperties && typeof r.appProperties === 'object') {
    meta.appProperties = { ...(r.appProperties as Record<string, string>) };
  }
  return meta;
}

function randomBoundary(): string {
  let s = '';
  for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 36).toString(36);
  return `band-sheets-${s}`;
}

/** RFC 2387 `multipart/related` body: metadata JSON, then the text. */
export function multipartBody(
  metadata: object,
  text: string,
  boundary: string,
): string {
  return [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${SONG_MIME_TYPE}; charset=UTF-8`,
    '',
    text,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export function createFetchDriveClient(o: {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
}): DriveClient {
  const doFetch: typeof fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));

  async function once(input: string, init: RequestInit): Promise<Response> {
    const token = await o.getToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await doFetch(input, { ...init, headers });
    } catch (e) {
      throw new DriveError(
        'network',
        undefined,
        e instanceof Error ? e.message : 'Network error',
      );
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  async function request(
    input: string,
    init: RequestInit = {},
    opts: { retryServer?: boolean } = {},
  ): Promise<Response> {
    try {
      return await once(input, init);
    } catch (e) {
      const retry =
        e instanceof DriveError &&
        (e.kind === 'rateLimit' ||
          (e.kind === 'server' && opts.retryServer !== false));
      if (!retry) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return once(input, init);
    }
  }

  async function json(
    input: string,
    init?: RequestInit,
    opts?: { retryServer?: boolean },
  ): Promise<unknown> {
    const res = await request(input, init, opts);
    try {
      return await res.json();
    } catch {
      throw new DriveError('other', res.status, 'Invalid JSON from Drive');
    }
  }

  async function listAll(
    q: string,
    orderBy?: string,
  ): Promise<DriveFileMeta[]> {
    const out: DriveFileMeta[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        q,
        fields: `nextPageToken,files(${META_FIELDS})`,
        pageSize: '1000',
        spaces: 'drive',
      };
      if (orderBy) params.orderBy = orderBy;
      if (pageToken) params.pageToken = pageToken;
      const body = (await json(url(DRIVE_API, params))) as {
        files?: unknown[];
        nextPageToken?: unknown;
      };
      for (const f of body.files ?? []) out.push(toMeta(f));
      pageToken =
        typeof body.nextPageToken === 'string' && body.nextPageToken
          ? body.nextPageToken
          : undefined;
    } while (pageToken);
    return out;
  }

  function uploadInit(
    method: 'POST' | 'PATCH',
    metadata: object,
    text: string,
  ): RequestInit {
    const boundary = randomBoundary();
    return {
      method,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody(metadata, text, boundary),
    };
  }

  return {
    async findFolder(name) {
      const q = [
        `name = ${quoteQ(name)}`,
        `mimeType = ${quoteQ(FOLDER_MIME_TYPE)}`,
        `'root' in parents`,
        'trashed = false',
      ].join(' and ');
      const found = await listAll(q, 'createdTime');
      return found[0] ?? null;
    },

    async createFolder(name, appProperties) {
      return toMeta(
        await json(url(DRIVE_API, { fields: META_FIELDS }), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({
            name,
            mimeType: FOLDER_MIME_TYPE,
            parents: ['root'],
            appProperties,
          }),
        }),
      );
    },

    listFiles(folderId) {
      return listAll(
        [
          `${quoteQ(folderId)} in parents`,
          'trashed = false',
          `mimeType != ${quoteQ(FOLDER_MIME_TYPE)}`,
        ].join(' and '),
      );
    },

    async getMeta(fileId) {
      const raw = await json(
        url(`${DRIVE_API}/${encodeURIComponent(fileId)}`, {
          fields: `${META_FIELDS},trashed`,
        }),
      );
      if ((raw as { trashed?: unknown })?.trashed === true) {
        throw new DriveError('notFound', undefined, 'File is in the trash');
      }
      return toMeta(raw);
    },

    async download(fileId) {
      const res = await request(
        url(`${DRIVE_API}/${encodeURIComponent(fileId)}`, { alt: 'media' }),
      );
      return res.text();
    },

    async create(a) {
      return toMeta(
        await json(
          url(DRIVE_UPLOAD_API, {
            uploadType: 'multipart',
            fields: META_FIELDS,
          }),
          uploadInit(
            'POST',
            {
              name: a.name,
              mimeType: SONG_MIME_TYPE,
              parents: [a.folderId],
              appProperties: a.appProperties,
            },
            a.text,
          ),
          { retryServer: false },
        ),
      );
    },

    async update(fileId, a) {
      return toMeta(
        await json(
          url(`${DRIVE_UPLOAD_API}/${encodeURIComponent(fileId)}`, {
            uploadType: 'multipart',
            fields: META_FIELDS,
          }),
          uploadInit(
            'PATCH',
            { name: a.name, appProperties: a.appProperties },
            a.text,
          ),
        ),
      );
    },

    async trash(fileId) {
      await request(
        url(`${DRIVE_API}/${encodeURIComponent(fileId)}`, { fields: 'id' }),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ trashed: true }),
        },
      );
    },
  };
}
