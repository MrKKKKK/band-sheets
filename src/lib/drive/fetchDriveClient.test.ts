import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveError } from './driveClient';
import {
  createFetchDriveClient,
  multipartBody,
  quoteQ,
  RETRY_DELAY_MS,
} from './fetchDriveClient';

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Reply = Response | Error | (() => Response);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function driveError(status: number, reason: string): Response {
  return json(
    {
      error: {
        code: status,
        message: reason,
        errors: [{ domain: 'usageLimits', reason, message: reason }],
      },
    },
    status,
  );
}

const META = {
  id: 'f1',
  name: 'Song.bandsheet',
  version: '7',
  modifiedTime: '2026-10-06T05:00:00.000Z',
  appProperties: { app: 'band-sheets', songId: 's1' },
};

/** A fake `fetch` answering from a queue; never reaches the network. */
function setup(replies: Reply[], token = 'tok') {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const r = queue.shift();
    if (!r) throw new Error('unexpected fetch');
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  });
  const getToken = vi.fn(async () => token);
  const client = createFetchDriveClient({
    getToken,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, calls, fetch, getToken };
}

async function rejection(p: Promise<unknown>): Promise<DriveError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DriveError);
    return e as DriveError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('quoteQ', () => {
  it('quotes and escapes backslashes and apostrophes', () => {
    expect(quoteQ('band-sheets')).toBe("'band-sheets'");
    expect(quoteQ("it's a\\b")).toBe("'it\\'s a\\\\b'");
  });
});

describe('multipartBody', () => {
  it('puts JSON metadata first and the UTF-8 text second, CRLF-delimited', () => {
    const body = multipartBody({ name: 'x' }, '{title: あ}\n', 'BB');
    expect(body).toBe(
      [
        '--BB',
        'Content-Type: application/json; charset=UTF-8',
        '',
        '{"name":"x"}',
        '--BB',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        '{title: あ}\n',
        '--BB--',
        '',
      ].join('\r\n'),
    );
  });
});

describe('createFetchDriveClient', () => {
  it('sends the bearer token from getToken on every request', async () => {
    const { client, calls, getToken } = setup([json(META)], 'abc');
    await client.getMeta('f1');
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(calls[0].headers.get('Authorization')).toBe('Bearer abc');
  });

  describe('findFolder', () => {
    it('queries non-trashed folders by name under root, oldest first', async () => {
      const { client, calls } = setup([
        json({
          files: [
            { ...META, id: 'old' },
            { ...META, id: 'new' },
          ],
        }),
      ]);
      const f = await client.findFolder("band'sheets");
      expect(f?.id).toBe('old');
      const u = calls[0].url;
      expect(u.origin + u.pathname).toBe(
        'https://www.googleapis.com/drive/v3/files',
      );
      expect(u.searchParams.get('q')).toBe(
        "name = 'band\\'sheets' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
      );
      expect(u.searchParams.get('orderBy')).toBe('createdTime');
      expect(u.searchParams.get('fields')).toBe(
        'nextPageToken,files(id,name,version,modifiedTime,appProperties)',
      );
      expect(calls[0].method).toBe('GET');
    });

    it('returns null when nothing matches', async () => {
      const { client } = setup([json({ files: [] })]);
      expect(await client.findFolder('band-sheets')).toBeNull();
    });
  });

  it('createFolder posts folder metadata under root with appProperties', async () => {
    const { client, calls } = setup([json({ ...META, id: 'fold' })]);
    const f = await client.createFolder('band-sheets', {
      app: 'band-sheets',
      role: 'root',
    });
    expect(f.id).toBe('fold');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.pathname).toBe('/drive/v3/files');
    expect(calls[0].url.searchParams.get('fields')).toBe(
      'id,name,version,modifiedTime,appProperties',
    );
    expect(calls[0].headers.get('Content-Type')).toContain('application/json');
    expect(JSON.parse(calls[0].body!)).toEqual({
      name: 'band-sheets',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      appProperties: { app: 'band-sheets', role: 'root' },
    });
  });

  describe('listFiles', () => {
    it('queries the folder children and follows nextPageToken', async () => {
      const { client, calls } = setup([
        json({ files: [{ ...META, id: 'a' }], nextPageToken: 'p2' }),
        json({ files: [{ ...META, id: 'b' }] }),
      ]);
      const files = await client.listFiles('fold');
      expect(files.map((f) => f.id)).toEqual(['a', 'b']);
      expect(calls).toHaveLength(2);
      const q = calls[0].url.searchParams;
      expect(q.get('q')).toBe(
        "'fold' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      );
      expect(q.get('pageSize')).toBe('1000');
      expect(q.get('pageToken')).toBeNull();
      expect(calls[1].url.searchParams.get('pageToken')).toBe('p2');
    });

    it('maps metadata and drops unknown fields', async () => {
      const { client } = setup([
        json({ files: [{ ...META, size: '12', extra: 1 }] }),
      ]);
      expect(await client.listFiles('fold')).toEqual([META]);
    });

    it('rejects a malformed file entry as other', async () => {
      const { client } = setup([json({ files: [{ id: 'x' }] })]);
      expect((await rejection(client.listFiles('fold'))).kind).toBe('other');
    });
  });

  describe('getMeta', () => {
    it('requests the meta fields plus trashed', async () => {
      const { client, calls } = setup([json({ ...META, trashed: false })]);
      expect(await client.getMeta('f/1')).toEqual(META);
      expect(calls[0].url.pathname).toBe('/drive/v3/files/f%2F1');
      expect(calls[0].url.searchParams.get('fields')).toBe(
        'id,name,version,modifiedTime,appProperties,trashed',
      );
    });

    it('treats a trashed file as notFound', async () => {
      const { client } = setup([json({ ...META, trashed: true })]);
      expect((await rejection(client.getMeta('f1'))).kind).toBe('notFound');
    });

    it('keeps a file without appProperties without the key', async () => {
      const { client } = setup([
        json({ id: 'f1', name: 'n', version: '1', modifiedTime: 't' }),
      ]);
      expect(await client.getMeta('f1')).toEqual({
        id: 'f1',
        name: 'n',
        version: '1',
        modifiedTime: 't',
      });
    });
  });

  it('download reads alt=media as text', async () => {
    const { client, calls } = setup([new Response('{title: 曲}\n')]);
    expect(await client.download('f1')).toBe('{title: 曲}\n');
    expect(calls[0].url.pathname).toBe('/drive/v3/files/f1');
    expect(calls[0].url.searchParams.get('alt')).toBe('media');
  });

  describe('create', () => {
    it('posts a multipart/related upload with metadata then text', async () => {
      const { client, calls } = setup([json(META)]);
      const meta = await client.create({
        folderId: 'fold',
        name: 'Song.bandsheet',
        text: '{title: Song}\n',
        appProperties: { app: 'band-sheets', songId: 's1' },
      });
      expect(meta).toEqual(META);
      const c = calls[0];
      expect(c.method).toBe('POST');
      expect(c.url.origin + c.url.pathname).toBe(
        'https://www.googleapis.com/upload/drive/v3/files',
      );
      expect(c.url.searchParams.get('uploadType')).toBe('multipart');
      expect(c.url.searchParams.get('fields')).toBe(
        'id,name,version,modifiedTime,appProperties',
      );
      const ct = c.headers.get('Content-Type')!;
      const boundary = /^multipart\/related; boundary=(.+)$/.exec(ct)?.[1];
      expect(boundary).toBeTruthy();
      expect(c.body).toBe(
        multipartBody(
          {
            name: 'Song.bandsheet',
            mimeType: 'text/plain',
            parents: ['fold'],
            appProperties: { app: 'band-sheets', songId: 's1' },
          },
          '{title: Song}\n',
          boundary!,
        ),
      );
    });

    it('does not retry a 5xx (the file may already exist)', async () => {
      vi.useFakeTimers();
      const { client, calls } = setup([driveError(503, 'backendError')]);
      const e = await rejection(
        client.create({
          folderId: 'f',
          name: 'n',
          text: '',
          appProperties: {},
        }),
      );
      expect(e.kind).toBe('server');
      expect(calls).toHaveLength(1);
    });

    it('retries a rate limit once', async () => {
      vi.useFakeTimers();
      const { client, calls } = setup([
        driveError(429, 'rateLimitExceeded'),
        json(META),
      ]);
      const p = client.create({
        folderId: 'f',
        name: 'n',
        text: '',
        appProperties: {},
      });
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(await p).toEqual(META);
      expect(calls).toHaveLength(2);
    });
  });

  it('update PATCHes name, appProperties and text in one multipart upload', async () => {
    const { client, calls } = setup([json({ ...META, version: '8' })]);
    const meta = await client.update('f1', {
      name: 'New.bandsheet',
      text: 'body',
      appProperties: { device: 'iPad' },
    });
    expect(meta.version).toBe('8');
    const c = calls[0];
    expect(c.method).toBe('PATCH');
    expect(c.url.origin + c.url.pathname).toBe(
      'https://www.googleapis.com/upload/drive/v3/files/f1',
    );
    expect(c.url.searchParams.get('uploadType')).toBe('multipart');
    expect(c.url.searchParams.get('fields')).toBe(
      'id,name,version,modifiedTime,appProperties',
    );
    const boundary = /boundary=(.+)$/.exec(c.headers.get('Content-Type')!)![1];
    expect(c.body).toBe(
      multipartBody(
        { name: 'New.bandsheet', appProperties: { device: 'iPad' } },
        'body',
        boundary,
      ),
    );
    expect(c.headers.get('If-Match')).toBeNull();
  });

  it('trash PATCHes trashed: true on the metadata endpoint', async () => {
    const { client, calls } = setup([json({ id: 'f1' })]);
    await client.trash('f1');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(
      'https://www.googleapis.com/drive/v3/files/f1',
    );
    expect(JSON.parse(calls[0].body!)).toEqual({ trashed: true });
  });

  describe('errors', () => {
    it.each([
      [driveError(401, 'authError'), 'auth', 401],
      [driveError(404, 'notFound'), 'notFound', 404],
      [driveError(403, 'insufficientFilePermissions'), 'other', 403],
      [driveError(403, 'storageQuotaExceeded'), 'other', 403],
      [driveError(400, 'badRequest'), 'other', 400],
      [new Response('not json', { status: 403 }), 'other', 403],
    ] as const)('maps %#', async (res, kind, status) => {
      const { client, calls } = setup([res]);
      const e = await rejection(client.getMeta('f1'));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expect(calls).toHaveLength(1); // not retried
    });

    it('maps a rejected fetch to network without retrying', async () => {
      const { client, calls } = setup([new TypeError('Failed to fetch')]);
      const e = await rejection(client.download('f1'));
      expect(e.kind).toBe('network');
      expect(e.status).toBeUndefined();
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['403 rateLimitExceeded', () => driveError(403, 'rateLimitExceeded')],
      [
        '403 userRateLimitExceeded',
        () => driveError(403, 'userRateLimitExceeded'),
      ],
      ['429', () => driveError(429, 'rateLimitExceeded')],
      ['500', () => driveError(500, 'backendError')],
      ['503', () => new Response('', { status: 503 })],
    ])('retries %s once after 1 s and succeeds', async (_, fail) => {
      vi.useFakeTimers();
      const { client, calls, getToken } = setup([fail(), json(META)]);
      const p = client.getMeta('f1');
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual(META);
      expect(calls).toHaveLength(2);
      expect(getToken).toHaveBeenCalledTimes(2);
    });

    it('gives up after one retry', async () => {
      vi.useFakeTimers();
      const { client, calls } = setup([
        driveError(403, 'userRateLimitExceeded'),
        driveError(403, 'userRateLimitExceeded'),
      ]);
      const p = rejection(client.getMeta('f1'));
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      const e = await p;
      expect(e.kind).toBe('rateLimit');
      expect(e.status).toBe(403);
      expect(calls).toHaveLength(2);
    });

    it('propagates a getToken failure untouched', async () => {
      const { client, getToken, fetch } = setup([]);
      const err = new DriveError('auth');
      getToken.mockRejectedValueOnce(err);
      await expect(client.getMeta('f1')).rejects.toBe(err);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
