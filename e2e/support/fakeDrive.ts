/**
 * An in-memory Google for e2e: a stub of the GIS script and a fake Drive API
 * v3 behind `page.route`. Nothing ever reaches Google — every other request
 * to a Google host is aborted.
 *
 * Versions follow Drive: every change (content, name, appProperties, trash)
 * bumps `version`; `modifiedTime` moves on content/name/appProperties changes.
 */

import type { Page, Route } from '@playwright/test';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GIS_URL = 'https://accounts.google.com/gsi/client';

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  text: string;
  version: number;
  modifiedTime: string;
  trashed: boolean;
}

const GIS_STUB = `
window.google = { accounts: { oauth2: {
  initTokenClient: function (cfg) {
    return {
      requestAccessToken: function () {
        window.__gisCalls = (window.__gisCalls || 0) + 1;
        setTimeout(function () {
          cfg.callback({
            access_token: 'fake-access-token',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive.file',
          });
        }, 0);
      },
    };
  },
  hasGrantedAllScopes: function () { return true; },
  revoke: function (t, done) { if (done) done({}); },
} } };
`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

export interface FakeDrive {
  /** Every request the app made: `"<METHOD> <path>"` (no query). */
  readonly requests: string[];
  /** While true every Drive request fails like a dropped connection. */
  offline: boolean;
  /** The next N Drive requests answer with this status (e.g. 500). */
  failNext(status: number, times?: number): void;
  /** Add a song file to the app folder (creating the folder if needed). */
  seed(a: {
    name: string;
    text: string;
    songId?: string;
    device?: string;
  }): FakeFile;
  /** Change a file behind the app's back (as another device would). */
  externalEdit(fileId: string, text: string): FakeFile;
  /** Trash a file behind the app's back (Drive UI / another device). */
  externalTrash(fileId: string): FakeFile;
  /** Song files in the app folder (not trashed). */
  songs(): FakeFile[];
  trashed(): FakeFile[];
  file(id: string): FakeFile | undefined;
  /** How many times the GIS popup was "opened". */
  gisCalls(page: Page): Promise<number>;
}

export async function installFakeDrive(page: Page): Promise<FakeDrive> {
  const files = new Map<string, FakeFile>();
  const requests: string[] = [];
  let seq = 0;
  let clockMs = Date.now();
  let failStatus = 0;
  let failCount = 0;

  const tick = () => {
    clockMs += 1000;
    return new Date(clockMs).toISOString();
  };
  const nextId = () => `fake${++seq}`;

  const meta = (f: FakeFile, withTrashed = false) => ({
    id: f.id,
    name: f.name,
    version: String(f.version),
    modifiedTime: f.modifiedTime,
    appProperties: f.appProperties,
    ...(withTrashed ? { trashed: f.trashed } : {}),
  });

  function appFolder(): FakeFile {
    let f = [...files.values()].find(
      (x) => x.mimeType === FOLDER_MIME && x.name === 'band-sheets',
    );
    if (!f) {
      f = {
        id: nextId(),
        name: 'band-sheets',
        mimeType: FOLDER_MIME,
        parents: ['root'],
        appProperties: {},
        text: '',
        version: 1,
        modifiedTime: tick(),
        trashed: false,
      };
      files.set(f.id, f);
    }
    return f;
  }

  const state: FakeDrive = {
    requests,
    offline: false,
    failNext(status, times = 1) {
      failStatus = status;
      failCount = times;
    },
    seed({ name, text, songId, device }) {
      const folder = appFolder();
      const id = nextId();
      const f: FakeFile = {
        id,
        name,
        mimeType: 'text/plain',
        parents: [folder.id],
        appProperties: {
          songId: songId ?? `seed-${id}`,
          ...(device ? { device } : {}),
        },
        text,
        version: 1,
        modifiedTime: tick(),
        trashed: false,
      };
      files.set(id, f);
      return f;
    },
    externalEdit(fileId, text) {
      const f = files.get(fileId);
      if (!f) throw new Error(`no such fake file ${fileId}`);
      f.text = text;
      f.version += 1;
      f.modifiedTime = tick();
      f.appProperties = { ...f.appProperties, device: 'iPad' };
      return f;
    },
    externalTrash(fileId) {
      const f = files.get(fileId);
      if (!f) throw new Error(`no such fake file ${fileId}`);
      f.trashed = true;
      f.version += 1;
      return f;
    },
    songs() {
      const folder = [...files.values()].find(
        (x) => x.mimeType === FOLDER_MIME,
      );
      return [...files.values()].filter(
        (f) =>
          f.mimeType !== FOLDER_MIME &&
          !f.trashed &&
          folder !== undefined &&
          f.parents.includes(folder.id),
      );
    },
    trashed: () => [...files.values()].filter((f) => f.trashed),
    file: (id) => files.get(id),
    gisCalls: (p) => p.evaluate(() => window.__gisCalls ?? 0),
  };

  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({
      status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const error = (route: Route, status: number) =>
    json(route, status, {
      error: { code: status, errors: [{ reason: 'fake' }] },
    });

  /** Parses the multipart/related body the app sends. */
  function parseMultipart(
    contentType: string,
    body: string,
  ): { metadata: Record<string, unknown>; text: string } {
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? '';
    const parts = body
      .split(`--${boundary}`)
      .filter((p) => p.trim() !== '' && p.trim() !== '--');
    const content = (p: string) => {
      const at = p.indexOf('\r\n\r\n');
      return p.slice(at + 4).replace(/\r\n$/, '');
    };
    return {
      metadata: JSON.parse(content(parts[0])) as Record<string, unknown>,
      text: parts[1] === undefined ? '' : content(parts[1]),
    };
  }

  // Registered first = lowest priority: anything else on a Google host dies.
  await page.route(
    /^https:\/\/([^/]*\.)?(google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com)\//,
    (route) => route.abort('blockedbyclient'),
  );

  await page.route(GIS_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: GIS_STUB,
    }),
  );

  await page.route(
    /^https:\/\/www\.googleapis\.com\/(upload\/)?drive\/v3\/files/,
    async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      if (method === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: CORS });
      }
      requests.push(`${method} ${u.pathname}`);
      if (state.offline) return route.abort('failed');
      if (failCount > 0) {
        failCount -= 1;
        return error(route, failStatus);
      }
      const upload = u.pathname.startsWith('/upload/');
      const id = decodeURIComponent(
        u.pathname.replace(/^\/(upload\/)?drive\/v3\/files\/?/, ''),
      );

      // files.list
      if (method === 'GET' && id === '') {
        const q = u.searchParams.get('q') ?? '';
        let list = [...files.values()].filter((f) => !f.trashed);
        if (q.includes(`mimeType = '${FOLDER_MIME}'`)) {
          list = list.filter((f) => f.mimeType === FOLDER_MIME);
          const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
          if (name !== undefined) list = list.filter((f) => f.name === name);
        } else {
          const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
          list = list.filter(
            (f) =>
              f.mimeType !== FOLDER_MIME &&
              (parent === undefined || f.parents.includes(parent)),
          );
        }
        return json(route, 200, { files: list.map((f) => meta(f)) });
      }

      // files.create (folder: JSON; song: multipart upload)
      if (method === 'POST') {
        if (upload) {
          const { metadata, text } = parseMultipart(
            req.headers()['content-type'] ?? '',
            req.postData() ?? '',
          );
          const f: FakeFile = {
            id: nextId(),
            name: String(metadata.name),
            mimeType: String(metadata.mimeType ?? 'text/plain'),
            parents: (metadata.parents as string[]) ?? ['root'],
            appProperties:
              (metadata.appProperties as Record<string, string>) ?? {},
            text,
            version: 1,
            modifiedTime: tick(),
            trashed: false,
          };
          files.set(f.id, f);
          return json(route, 200, meta(f));
        }
        const body = JSON.parse(req.postData() ?? '{}') as Record<
          string,
          unknown
        >;
        const f: FakeFile = {
          id: nextId(),
          name: String(body.name),
          mimeType: String(body.mimeType ?? FOLDER_MIME),
          parents: (body.parents as string[]) ?? ['root'],
          appProperties: (body.appProperties as Record<string, string>) ?? {},
          text: '',
          version: 1,
          modifiedTime: tick(),
          trashed: false,
        };
        files.set(f.id, f);
        return json(route, 200, meta(f));
      }

      const f = files.get(id);
      if (!f) return error(route, 404);

      if (method === 'GET') {
        if (u.searchParams.get('alt') === 'media') {
          return route.fulfill({
            status: 200,
            headers: { ...CORS, 'content-type': 'text/plain; charset=UTF-8' },
            body: f.text,
          });
        }
        return json(route, 200, meta(f, true));
      }

      if (method === 'PATCH') {
        if (upload) {
          const { metadata, text } = parseMultipart(
            req.headers()['content-type'] ?? '',
            req.postData() ?? '',
          );
          if (typeof metadata.name === 'string') f.name = metadata.name;
          if (metadata.appProperties)
            f.appProperties = {
              ...f.appProperties,
              ...(metadata.appProperties as Record<string, string>),
            };
          f.text = text;
          f.version += 1;
          f.modifiedTime = tick();
          return json(route, 200, meta(f));
        }
        const body = JSON.parse(req.postData() ?? '{}') as Record<
          string,
          unknown
        >;
        if (body.trashed === true) {
          f.trashed = true;
          f.version += 1;
        }
        return json(route, 200, { id: f.id });
      }

      return error(route, 405);
    },
  );

  return state;
}

declare global {
  interface Window {
    __gisCalls?: number;
  }
}
