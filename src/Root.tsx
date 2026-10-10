/**
 * The outermost component (docs/m7-plan.md, decision 5 / T16): hash routing
 * (`#/` list, `#/edit/<id>`, `#/view/<id>`, `#/new` → a new id, the M6
 * `#view` bookmark → list), the first screen (sign-in vs. list), the PC vs.
 * tablet list, and the one-time `migrateLegacyLocal` at startup.
 *
 * `auth` / `client` / `storage` are injected: `main.tsx` passes the real
 * GIS auth and (by default) the fetch Drive client; tests and stories pass
 * `createFakeAuth` / `createFakeDriveClient` / `createMemoryStorage`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Root.module.css';
import { AccountMenu } from './components/AccountMenu/AccountMenu';
import { Button } from './components/Button/Button';
import { ConnectionBanner } from './components/ConnectionBanner/ConnectionBanner';
import { SignInScreen } from './components/SignInScreen/SignInScreen';
import { SongList } from './components/SongList/SongList';
import { TabletSongList } from './components/TabletSongList/TabletSongList';
import type { ViewerClock } from './components/Viewer/viewerClock';
import { useDriveSession, type FailReason } from './hooks/useDriveSession';
import {
  useSongLibrary,
  type ActionResult,
  type SongLibrary,
} from './hooks/useSongLibrary';
import type { AuthErrorKind, DriveAuth } from './lib/auth/gis';
import type { DriveClient } from './lib/drive/driveClient';
import { parseRoute, routeHash, type Route } from './lib/route';
import {
  loadBase,
  loadDraftRecord,
  migrateLegacyLocal,
  type KeyValueStorage,
} from './lib/storage';
import type { SortOrder } from './lib/syncTypes';
import { EditorScreen } from './screens/EditorScreen';
import { ViewerScreen } from './screens/ViewerScreen';

export type RootProps = {
  auth: DriveAuth;
  storage: KeyValueStorage | null;
  /** Default: the fetch Drive client (real Google). Tests pass a fake. */
  client?: DriveClient;
  /** Touch-only device → the tablet list. Default: matchMedia. */
  tablet?: boolean;
  /** Mac → 「⌘S」 in the save button. Default: navigator. */
  mac?: boolean;
  detectDevice?: () => string;
  newId?: () => string;
  now?: () => Date;
  /** Viewer auto-scroll clock (tests). */
  clock?: ViewerClock;
};

/** Edit/view routes only: 'new' is resolved to an id before it is stored. */
type Screen = Exclude<Route, { screen: 'new' }>;

function defaultNewId(): string {
  return crypto.randomUUID();
}

function isTouchOnly(): boolean {
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches
    );
  } catch {
    return false;
  }
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

const SIGN_IN_ERROR: Record<AuthErrorKind, string> = {
  popupBlocked:
    'ログインの画面がブロックされました。ポップアップを許可して、もう一度押してください。',
  popupClosed: 'ログインの画面が閉じられました。もう一度お試しください。',
  denied:
    'Drive へのアクセスが許可されませんでした。「band-sheets に許可する」を選んでください。',
  scriptLoad: 'Google に接続できません。通信を確認してください。',
  needsSignIn: 'ログインしてください。',
  unconfigured: 'Drive は設定されていません。',
  unknown: 'ログインできませんでした。もう一度お試しください。',
};

const FAIL: Record<FailReason, string> = {
  network: '通信できませんでした。',
  auth: 'ログインの期限が切れました。もう一度お試しください。',
  other: '操作できませんでした。',
};

function actionError(
  r: ActionResult,
  what: '名前の変更' | '複製' | '削除',
): string | null {
  if (r.ok) return null;
  if (r.reason === 'notAllowed')
    return '未保存の変更があるときは、編集画面で曲名を変えてください。';
  if (r.reason === 'conflict')
    return 'Drive の版が新しくなっていたため、名前を変えられませんでした。もう一度お試しください。';
  return `${what}ができませんでした。${FAIL[r.reason]}`;
}

export function Root({
  auth,
  storage,
  client,
  tablet: tabletProp,
  mac: macProp,
  detectDevice,
  newId = defaultNewId,
  now,
  clock,
}: RootProps) {
  // Once, before the library first reads the index (a second call — e.g.
  // StrictMode — finds nothing left to move).
  useState(() => migrateLegacyLocal(storage, newId, now?.() ?? new Date()));
  const [tablet] = useState(() => tabletProp ?? isTouchOnly());
  const [shortcutLabel] = useState(() =>
    (macProp ?? isMac()) ? '⌘S' : 'Ctrl+S',
  );

  const session = useDriveSession({ auth, storage, client, detectDevice });
  const library = useSongLibrary(session, { now, newId });

  // Ids made by `#/new` in this tab: the only unknown ids that may open as
  // an empty new song (m7-review.md R6).
  const [created] = useState(() => new Set<string>());
  const resolve = useCallback(
    (r: Route): Screen => {
      if (r.screen !== 'new') return r;
      const songId = newId();
      created.add(songId);
      return { screen: 'edit', songId };
    },
    [newId, created],
  );
  const [route, setRoute] = useState<Screen>(() =>
    resolve(parseRoute(window.location.hash)),
  );
  // Whether the current view entry was pushed by the editor's 「閲覧モード」.
  const pushedView = useRef(false);

  // The editor stays mounted (hidden) while viewing the song it was editing.
  const [editorSong, setEditorSong] = useState<string | null>(() =>
    route.screen === 'edit' ? route.songId : null,
  );
  const wantEditor =
    route.screen === 'edit'
      ? route.songId
      : route.screen === 'view' && route.songId === editorSong
        ? editorSong
        : null;
  if (wantEditor !== editorSong) setEditorSong(wantEditor);

  // Keep the URL canonical ('' / '#view' → '#/', '#/new' → '#/edit/<id>').
  useEffect(() => {
    const hash = routeHash(route);
    if (window.location.hash !== hash) {
      window.history.replaceState(window.history.state, '', hash);
    }
  }, [route]);

  useEffect(() => {
    const onNav = () => {
      const parsed = parseRoute(window.location.hash);
      const next = resolve(parsed);
      // Replace '#/new' at once: popstate and hashchange both arrive for
      // one navigation, and must not create two new songs.
      if (parsed.screen === 'new')
        window.history.replaceState(null, '', routeHash(next));
      pushedView.current = false;
      setRoute((cur) => (routeHash(cur) === routeHash(next) ? cur : next));
    };
    window.addEventListener('hashchange', onNav);
    window.addEventListener('popstate', onNav);
    return () => {
      window.removeEventListener('hashchange', onNav);
      window.removeEventListener('popstate', onNav);
    };
  }, [resolve]);

  const navigate = useCallback(
    (next: Route, opts: { replace?: boolean } = {}) => {
      const r = resolve(next);
      const hash = routeHash(r);
      if (opts.replace) window.history.replaceState(null, '', hash);
      else window.history.pushState(null, '', hash);
      setRoute(r);
    },
    [resolve],
  );

  // Drafts written by the editor (flushed when it unmounts) don't notify
  // the library: re-read when the list is shown.
  const { reload } = library;
  useEffect(() => {
    if (route.screen === 'list') reload();
  }, [route.screen, reload]);

  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<SortOrder>('modified');

  const signIn = () => {
    // In the click handler: signIn() opens the GIS popup synchronously.
    void session.signIn();
  };
  const signInError =
    session.signInError === null
      ? undefined
      : SIGN_IN_ERROR[session.signInError];

  // A song URL this device knows nothing about (made on another device
  // since the last listing, deleted, a typo…) must never open as an empty
  // new song — saving it would make a second file for the same id (R6).
  // Signed in: wait for the running / first listing, then list once more;
  // still unknown → explain, with a way back.
  const songIdOf = route.screen === 'list' ? null : route.songId;
  const unknown =
    songIdOf !== null &&
    !created.has(songIdOf) &&
    !library.songs.some((s) => s.songId === songIdOf) &&
    loadBase(storage, songIdOf) === null &&
    loadDraftRecord(storage, songIdOf) === null;
  const signedIn = session.status === 'signedIn';
  /** The unknown id the last extra listing was done for. */
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const requested = useRef<string | null>(null);
  const { refresh } = library;
  const listPending =
    library.refreshing || (!library.listedAt && library.refreshError === null);
  const lookUp = unknown && signedIn && !listPending && lookedUp !== songIdOf;
  useEffect(() => {
    if (!lookUp || songIdOf === null || requested.current === songIdOf) return;
    requested.current = songIdOf;
    // Signed in: the token is there, no popup.
    void refresh().finally(() => setLookedUp(songIdOf));
  }, [lookUp, songIdOf, refresh]);
  const lookingUp =
    unknown && signedIn && (listPending || lookedUp !== songIdOf);

  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshList = () => {
    // In the click handler (may open the GIS popup).
    void refresh().then((ok) => setRefreshFailed(!ok));
  };
  if (refreshFailed && library.refreshError === null && !library.refreshing)
    setRefreshFailed(false);

  let screen;
  if (lookingUp) {
    screen = (
      <main className={styles.loading} data-testid="root-loading">
        <p role="status">Drive の曲の一覧を読み込んでいます…</p>
      </main>
    );
  } else if (unknown) {
    screen = (
      <main className={styles.unknown} data-testid="unknown-song">
        <Button variant="ghost" onClick={() => navigate({ screen: 'list' })}>
          ‹ 曲の一覧
        </Button>
        <p role="alert" className={styles.unknownText}>
          この曲は見つかりません。Drive
          で削除されたか、まだこの端末の曲の一覧に無い曲です。
          {session.configured && !signedIn
            ? ' Drive に接続すると探せます。'
            : ''}
        </p>
        {session.configured && !signedIn && (
          <Button
            onClick={() =>
              session.connected
                ? void session.ensureToken().catch(() => undefined)
                : signIn()
            }
          >
            {session.connected ? 'Drive に再接続' : 'ログイン'}
          </Button>
        )}
        {signedIn && (
          <Button disabled={library.refreshing} onClick={refreshList}>
            もう一度探す
          </Button>
        )}
      </main>
    );
  } else if (
    route.screen === 'edit' ||
    (route.screen === 'view' && wantEditor)
  ) {
    const songId = route.songId;
    screen = (
      <EditorScreen
        key={songId}
        session={session}
        songId={songId}
        viewing={route.screen === 'view'}
        onEnterView={() => {
          pushedView.current = true;
          navigate({ screen: 'view', songId });
        }}
        onExitView={() => {
          if (pushedView.current) {
            pushedView.current = false;
            window.history.back();
          } else {
            navigate({ screen: 'edit', songId }, { replace: true });
          }
        }}
        onBackToList={() => navigate({ screen: 'list' })}
        shortcutLabel={shortcutLabel}
        now={now}
        newId={newId}
      />
    );
  } else if (route.screen === 'view') {
    screen = (
      <ViewerScreen
        key={route.songId}
        session={session}
        songId={route.songId}
        onBack={() => navigate({ screen: 'list' })}
        clock={clock}
      />
    );
  } else if (
    library.songs.length === 0 &&
    session.status !== 'signedIn' &&
    session.status !== 'expired'
  ) {
    screen = (
      <SignInScreen
        configured={session.configured}
        signingIn={session.signingIn}
        error={signInError}
        onSignIn={signIn}
        onStartWithoutSignIn={() => navigate({ screen: 'new' })}
      />
    );
  } else if (tablet) {
    screen = (
      <TabletList
        library={library}
        refreshFailed={refreshFailed}
        onRefresh={refreshList}
        signedOut={session.configured && !session.connected}
        signingIn={session.signingIn}
        onSignIn={signIn}
        onSignOut={() => void session.signOut()}
        query={query}
        onQueryChange={setQuery}
        order={order}
        onOrderChange={setOrder}
        onOpenView={(id) => navigate({ screen: 'view', songId: id })}
        now={now}
      />
    );
  } else {
    const report =
      (what: '名前の変更' | '複製' | '削除') => (r: ActionResult) =>
        setMessage(actionError(r, what));
    screen = (
      <SongList
        songs={library.songs}
        statuses={library.statuses}
        signedIn={session.connected}
        configured={session.configured}
        onSignIn={signIn}
        onSignOut={() => void session.signOut()}
        signingIn={session.signingIn}
        onRefresh={refreshList}
        refreshing={library.refreshing}
        connection={
          library.banner
            ? {
                kind: library.banner,
                listedAt: library.listedAt,
                onRetry: () => void library.refresh(),
                retrying: library.refreshing,
              }
            : undefined
        }
        onNew={() => navigate({ screen: 'new' })}
        onOpen={(id) => navigate({ screen: 'edit', songId: id })}
        onOpenView={(id) => navigate({ screen: 'view', songId: id })}
        canRename={library.canRename}
        onRename={(id, title) =>
          void library.rename(id, title).then(report('名前の変更'))
        }
        onDuplicate={(id) => void library.duplicate(id).then(report('複製'))}
        onDelete={(id) => void library.remove(id).then(report('削除'))}
        busy={library.busyId !== null}
        order={order}
        onOrderChange={setOrder}
        now={now?.()}
      />
    );
  }

  const listShown = route.screen === 'list';
  return (
    <>
      {screen}
      {listShown && (message || (signInError && library.songs.length > 0)) && (
        <div className={styles.toast} role="alert" data-testid="root-message">
          <span>{message ?? signInError}</span>
          {message && (
            <button
              type="button"
              className={styles.close}
              onClick={() => setMessage(null)}
            >
              閉じる
            </button>
          )}
        </div>
      )}
    </>
  );
}

function TabletList({
  library,
  refreshFailed,
  onRefresh,
  signedOut,
  signingIn,
  onSignIn,
  onSignOut,
  query,
  onQueryChange,
  order,
  onOrderChange,
  onOpenView,
  now,
}: {
  library: SongLibrary;
  refreshFailed: boolean;
  onRefresh: () => void;
  signedOut: boolean;
  signingIn: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  order: SortOrder;
  onOrderChange: (o: SortOrder) => void;
  onOpenView: (songId: string) => void;
  now?: () => Date;
}) {
  const offline = library.banner === 'offline';
  return (
    <div className={styles.tablet}>
      {signedOut && (
        <div className={styles.tabletBar}>
          <span>ログインすると Drive の曲が出ます。</span>
          <AccountMenu
            signedIn={false}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
            busy={signingIn}
          />
        </div>
      )}
      {library.banner && library.banner !== 'offline' && (
        <ConnectionBanner
          kind={library.banner}
          onRetry={() => void library.refresh()}
          retrying={library.refreshing}
        />
      )}
      <TabletSongList
        songs={library.songs}
        cachedIds={library.cachedIds}
        query={query}
        onQueryChange={onQueryChange}
        order={order}
        onOrderChange={onOrderChange}
        offline={offline}
        listedAt={library.listedAt}
        refreshing={library.refreshing}
        refreshFailed={refreshFailed}
        onRefresh={onRefresh}
        onOpenView={onOpenView}
        now={now?.()}
      />
    </div>
  );
}
