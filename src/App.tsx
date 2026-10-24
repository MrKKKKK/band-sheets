import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useId,
  useMemo,
  useState,
} from 'react';
import styles from './App.module.css';
import { Button } from './components/Button/Button';
import { DrumEditor } from './components/DrumEditor/DrumEditor';
import { EditorErrorBoundary } from './components/EditorErrorBoundary/EditorErrorBoundary';
import { EasyEditor, type Step } from './components/EasyEditor/EasyEditor';
import {
  MelodyEditor,
  type HumImportRequest,
} from './components/MelodyEditor/MelodyEditor';
import { SegmentedControl } from './components/SegmentedControl/SegmentedControl';
import { SongInfoPopover } from './components/SongInfoPopover/SongInfoPopover';
import { Tabs } from './components/Tabs/Tabs';
import { TextEditor } from './components/TextEditor/TextEditor';
import { Viewer } from './components/Viewer/Viewer';
import { useAutosave } from './hooks/useAutosave';
import { lyricsText } from './lib/lyrics';
import { clearStaleMetaLines, type MetaField } from './lib/meta';
import { parseSong } from './lib/parseSong';
import { newSongText, serializeSong, UNTITLED } from './lib/serializeSong';
import type { Song, SongMeta } from './lib/song';
import {
  LOCAL_SONG_ID,
  getLocalStorage,
  loadDraftRecord,
  loadEditorMode,
  saveEditorMode,
  type EditorMode,
  type KeyValueStorage,
} from './lib/storage';

// 「鼻歌から下書き」 (S2 → S4) is its own chunk with the analysis client: the editor loads it on first use only.
const HumImportScreen = lazy(() =>
  import('./screens/HumImportScreen').then((m) => ({
    default: m.HumImportScreen,
  })),
);

/** Touch-only devices get no humming import entry (plan §4: PC only), like Root's tablet list. */
function isTouchOnly(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

export type AppProps = {
  /** Defaults to `window.localStorage`; stories / tests pass their own. */
  storage?: KeyValueStorage | null;
  /**
   * All of App's state is initialized once per mount from `songId`,
   * `initialText` and `baseVersion`; a caller switching songs must remount
   * App (`<App key={songId} />`, m3-review.md N7).
   */
  songId?: string;
  /**
   * The text the editor opens with. When omitted App reads the stored draft
   * of `songId` (or starts a new song) — kept so a bare `<App />` still works.
   */
  initialText?: string;
  /** Drive version editing started from (null: not on Drive). Saved with drafts. */
  baseVersion?: string | null;
  /** Header slots: left of the song info (e.g. 「‹ 曲の一覧」) / right (save UI). */
  headerStart?: ReactNode;
  headerEnd?: ReactNode;
  /** Called with the new text on every edit (not for the initial text). */
  onTextChange?: (text: string) => void;
  /**
   * Viewer mode, controlled by the caller (which owns the URL hash). When
   * `viewing` is undefined App keeps it in local state (no URL involved).
   * The editors stay mounted (hidden) while viewing.
   */
  viewing?: boolean;
  onEnterView?: () => void;
  onExitView?: () => void;
  /** Label of the viewer's back button (default 「← 編集に戻る」). */
  viewBackLabel?: string;
};

const MODE_HINT =
  'どちらも同じ ChordPro テキストを編集するので、いつ切り替えても内容はそのままです。';

type Instrument = 'chart' | 'melody' | 'drums';

const MODES: { value: EditorMode; label: string }[] = [
  { value: 'easy', label: 'かんたん入力' },
  { value: 'text', label: 'テキスト入力' },
];

const META_FIELDS: MetaField[] = ['title', 'key', 'tempo', 'time'];

/**
 * Scalar meta fields that went from set to empty between `prev` and `next`
 * (m3-review.md F1/N5): exactly the fields SongInfoPopover's 適用 actually
 * cleared, used to call `clearStaleMetaLines` for those fields only — never
 * inferred from "the field happens to be undefined" (that also covers a
 * field that was already unset, or a line relocated there by some unrelated
 * transformation such as applyLyrics merging sections, neither of which the
 * user cleared).
 */
function clearedMetaFields(prev: SongMeta, next: SongMeta): MetaField[] {
  return META_FIELDS.filter((field) => {
    const was =
      field === 'title' ? prev.title !== '' : prev[field] !== undefined;
    const now =
      field === 'title' ? next.title === '' : next[field] === undefined;
    return was && now;
  });
}

function App({
  storage,
  songId = LOCAL_SONG_ID,
  initialText,
  baseVersion,
  headerStart,
  headerEnd,
  onTextChange,
  viewing: viewingProp,
  onEnterView,
  onExitView,
  viewBackLabel,
}: AppProps) {
  const store = useMemo(
    () => (storage === undefined ? getLocalStorage() : storage),
    [storage],
  );
  // The ChordPro text is the single source of truth (docs/m3-plan.md, 1).
  const [initialDraft] = useState(() =>
    initialText === undefined ? loadDraftRecord(store, songId) : null,
  );
  const [text, setTextState] = useState(
    () => initialText ?? initialDraft?.text ?? newSongText(),
  );
  const [openedText] = useState(text);
  const openedBase = baseVersion ?? initialDraft?.baseVersion ?? null;
  const onTextChangeRef = useRef(onTextChange);
  useEffect(() => {
    onTextChangeRef.current = onTextChange;
  });
  // Once the text has diverged from the opened text, report every later
  // change too — including an edit back to the opened text, or the parent
  // would keep (and save) the last diverged text. Reported synchronously
  // from the change itself (not from an effect), so a Ctrl+S right after
  // typing saves the new text.
  const changedRef = useRef(false);
  const lastTextRef = useRef(text);
  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      if (next === lastTextRef.current) return;
      lastTextRef.current = next;
      if (next !== openedText) changedRef.current = true;
      if (changedRef.current) onTextChangeRef.current?.(next);
    },
    [openedText],
  );
  const song = useMemo(() => parseSong(text), [text]);
  const [mode, setMode] = useState<EditorMode>(() => loadEditorMode(store));
  const [instrument, setInstrument] = useState<Instrument>('chart');
  // Editor A's step-1 draft, lifted out of EasyEditor so it survives
  // switching to editor B and back without applying (m3-review.md R3).
  // `easyBase` is the lyrics text the draft was created from; comparing the
  // draft against it tells an untouched draft (safe to refresh whenever the
  // song's lyrics change) from one the user actually edited (m3-review.md
  // N1 — without this, a step-1 draft went stale when editor B changed the
  // lyrics, and re-applying it deleted the new lines).
  const currentLyrics = lyricsText(song);
  const [easyStep, setEasyStep] = useState<Step>(() =>
    currentLyrics === '' ? 'lyrics' : 'chords',
  );
  const [easyDraft, setEasyDraft] = useState(() => currentLyrics);
  const [easyBase, setEasyBase] = useState(() => currentLyrics);
  // Previous currentLyrics, tracked during render rather than in an effect
  // (React's "adjusting state when a prop changes" pattern) so a lyrics
  // change is handled in the same commit instead of an extra effect round
  // trip. An untouched draft (never diverged from its base) just follows
  // the song's lyrics, including the step: no lyrics → step 1, lyrics and
  // no edited draft → step 2 (m3-review.md N1). An edited draft is left in
  // place; `lyricsChangedNotice` below offers to reset or knowingly keep it.
  const [prevLyrics, setPrevLyrics] = useState(currentLyrics);
  if (currentLyrics !== prevLyrics) {
    setPrevLyrics(currentLyrics);
    if (easyDraft === easyBase) {
      setEasyDraft(currentLyrics);
      setEasyBase(currentLyrics);
      setEasyStep(currentLyrics === '' ? 'lyrics' : 'chords');
    }
  }

  // Shown in step 1 when the draft diverged from its base AND the base
  // itself changed since (m3-review.md N1).
  const lyricsChangedNotice =
    easyDraft !== easyBase && currentLyrics !== easyBase;
  const resetEasyDraft = () => {
    setEasyDraft(currentLyrics);
    setEasyBase(currentLyrics);
  };
  const keepEasyDraft = () => setEasyBase(currentLyrics);

  const modeHintId = useId();

  // Viewer mode is controlled by the caller (it owns the URL hash). Without
  // a `viewing` prop App keeps the flag itself.
  const [localViewing, setLocalViewing] = useState(false);
  const viewing = viewingProp ?? localViewing;
  const enterView = () => {
    if (viewingProp === undefined) setLocalViewing(true);
    onEnterView?.();
  };
  const exitView = () => {
    if (viewingProp === undefined) setLocalViewing(false);
    onExitView?.();
  };

  useAutosave(text, songId, store, openedBase);

  // The humming import screens replace the editor (which stays mounted, hidden) until inserted / cancelled.
  // Opening them pushes ONE history entry (same URL, so Root's hash routing does not see it): browser back acts
  // like 「やめて戻る」, and leaving by a button consumes the entry, so back from the editor still goes to the list.
  const [hum, setHum] = useState<HumImportRequest | null>(null);
  const [humEntry] = useState(() => !isTouchOnly());
  const [shownSection, setShownSection] = useState<{
    label: string;
    seq: number;
  } | null>(null);
  /** A new value = focus the 「鼻歌から下書き」 button again (after 「やめて戻る」). */
  const [entryFocus, setEntryFocus] = useState(0);
  /** A new value = the browser's back button was pressed on the humming screens. */
  const [humBack, setHumBack] = useState(0);
  /** The entry was already popped by the browser (do not consume it again). */
  const humPopped = useRef(false);
  /** Our own history.back() (consuming the entry) must not count as the user's back. */
  const ignorePop = useRef(false);

  const openHum = (req: HumImportRequest) => {
    window.history.pushState({ bandSheetsHum: true }, '', window.location.href);
    humPopped.current = false;
    ignorePop.current = false;
    setHum(req);
  };
  const closeHum = () => {
    if (!humPopped.current) {
      ignorePop.current = true;
      window.history.back();
    }
    humPopped.current = false;
    setHum(null);
  };
  useEffect(() => {
    if (!hum) return;
    const onPop = () => {
      if (ignorePop.current) {
        ignorePop.current = false;
        return;
      }
      humPopped.current = true;
      setHumBack((n) => n + 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [hum]);
  // Browser back cancelled on the confirmation: stay, with the entry back in place.
  const stayOnHum = () => {
    window.history.pushState({ bandSheetsHum: true }, '', window.location.href);
    humPopped.current = false;
  };
  const leaveHum = () => {
    closeHum();
    setEntryFocus((n) => n + 1);
  };
  const insertHum = (next: Song, label: string) => {
    setText(serializeSong(next));
    closeHum();
    setShownSection((s) => ({ label, seq: (s?.seq ?? 0) + 1 }));
  };

  const title = song.meta.title.trim() || UNTITLED;
  useEffect(() => {
    document.title = viewing
      ? `${title} - 閲覧 - band-sheets`
      : `${title} - band-sheets`;
  }, [title, viewing]);

  const changeMode = (next: EditorMode) => {
    setMode(next);
    saveEditorMode(store, next);
  };

  const requestTextEdit = () => {
    exitView();
    setInstrument('chart');
    changeMode('text');
  };

  const chartPanel = (
    <div className={styles.chartPanel}>
      {/* Keeps the heading order h1 → h2 → h3 (editor section headings). */}
      <h2 className={styles.srOnly}>コード譜</h2>
      <div className={styles.modeBar}>
        <SegmentedControl
          label="入力方法"
          options={MODES}
          value={mode}
          onChange={changeMode}
          aria-describedby={modeHintId}
        />
        <p id={modeHintId} className={styles.hint}>
          {MODE_HINT}
        </p>
      </div>
      {mode === 'easy' ? (
        <EasyEditor
          song={song}
          onChange={(next) => setText(serializeSong(next))}
          step={easyStep}
          onStepChange={setEasyStep}
          draft={easyDraft}
          onDraftChange={(next) => {
            setEasyDraft(next);
            // Starting fresh from the song (editLyrics) sets the draft to
            // exactly the current lyrics: treat that as a new base too.
            if (next === currentLyrics) setEasyBase(currentLyrics);
          }}
          lyricsChangedNotice={lyricsChangedNotice}
          onResetDraft={resetEasyDraft}
          onKeepDraft={keepEasyDraft}
        />
      ) : (
        <div className={styles.textEditor}>
          <TextEditor text={text} onTextChange={setText} />
        </div>
      )}
    </div>
  );

  return (
    <>
      {viewing && (
        <div className={styles.viewer}>
          <EditorErrorBoundary
            resetKey={text}
            onRequestTextEdit={requestTextEdit}
          >
            <Viewer
              key={songId}
              song={song}
              songId={songId}
              storage={store}
              onExit={exitView}
              backLabel={viewBackLabel}
            />
          </EditorErrorBoundary>
        </div>
      )}
      {hum && !viewing && (
        <Suspense
          fallback={
            <p role="status" className={styles.hint}>
              読み込んでいます…
            </p>
          }
        >
          <HumImportScreen
            song={song}
            partIndex={hum.partIndex}
            partName={hum.partName}
            initialLabel={hum.label}
            ts={hum.ts}
            keySig={hum.keySig}
            storage={store}
            onInsert={insertHum}
            onBack={leaveHum}
            backRequest={humBack}
            onStay={stayOnHum}
          />
        </Suspense>
      )}
      <div className={styles.app} hidden={viewing || hum !== null}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <div className={styles.headerLead}>
              {headerStart}
              <div className={styles.songInfo}>
                <span className={styles.brand}>band-sheets</span>
                <h1 className={styles.title}>{title}</h1>
                <SongInfoPopover
                  meta={song.meta}
                  onChange={(meta) => {
                    const cleared = clearStaleMetaLines(
                      song,
                      clearedMetaFields(song.meta, meta),
                    );
                    setText(serializeSong({ ...cleared, meta }));
                  }}
                />
              </div>
            </div>
            <div className={styles.headerActions}>
              <Button variant="secondary" onClick={enterView}>
                閲覧モード
              </Button>
              {headerEnd}
            </div>
          </div>
        </header>
        <Tabs
          label="楽器"
          selected={instrument}
          onSelect={setInstrument}
          barClassName={styles.tabBar}
          listClassName={styles.tabList}
          panelClassName={styles.main}
          tabs={[
            { id: 'chart', label: 'コード譜', content: chartPanel },
            {
              id: 'melody',
              label: 'メロディ',
              // Each editor tab has its own error boundary (m5-review.md R1):
              // every panel stays mounted, so an exception in one would
              // otherwise blank the whole app. It resets when the text changes.
              content: (
                <EditorErrorBoundary
                  resetKey={text}
                  onRequestTextEdit={requestTextEdit}
                >
                  <MelodyEditor
                    song={song}
                    onChange={(next) => setText(serializeSong(next))}
                    onRequestTextEdit={requestTextEdit}
                    onHumImport={humEntry ? openHum : undefined}
                    focusHumEntry={entryFocus}
                    showSection={shownSection}
                  />
                </EditorErrorBoundary>
              ),
            },
            {
              id: 'drums',
              label: 'ドラム',
              content: (
                <EditorErrorBoundary
                  resetKey={text}
                  onRequestTextEdit={requestTextEdit}
                >
                  <DrumEditor
                    song={song}
                    onChange={(next) => setText(serializeSong(next))}
                    onRequestTextEdit={requestTextEdit}
                  />
                </EditorErrorBoundary>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

export default App;
