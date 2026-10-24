import { useId, useRef, useState, type DragEvent, type Ref } from 'react';
import { formatClock, formatFileSize } from '../../lib/import/chordReview';
import { Button } from '../Button/Button';
import styles from './ImportPicker.module.css';

export interface PickedFile {
  name: string;
  size: number;
  /** Seconds; null = not known before decoding. */
  duration: number | null;
}

export interface ImportNotice {
  /** `notice` = the user cancelled (neutral), `error` = something went wrong. */
  severity: 'error' | 'notice';
  message: string;
  /** Offer 「もう一度試す」 (crash / memory / internal errors, and after a cancel). */
  retry?: boolean;
}

export type ImportPickerProps = {
  file: PickedFile | null;
  /** Shown above the file picker (plan §6.2; texts from importErrors.ts). */
  notice?: ImportNotice | null;
  onPick: (file: File) => void;
  onStart: () => void;
  /** 「もう一度試す」 / 「もう一度解析する」 with the same file. */
  onRetry?: () => void;
  /** The notice box (focused by the screen when a notice appears). */
  noticeRef?: Ref<HTMLDivElement>;
};

const ACCEPT = 'audio/*,.wav,.mp3,.m4a';

/** S1 「録音から新しい曲」 before / between analyses: pick a file, read what happens, start. */
export function ImportPicker({
  file,
  notice,
  onPick,
  onStart,
  onRetry,
  noticeRef,
}: ImportPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const whatId = useId();
  const choose = () => input.current?.click();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onPick(f);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  };

  return (
    <div className={styles.picker}>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className={styles.srOnly}
        aria-label="音声ファイル"
        tabIndex={-1}
        data-testid="audio-file-input"
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          // the same file can be picked again after an error
          e.currentTarget.value = '';
          if (f) onPick(f);
        }}
      />

      {notice ? (
        <div
          ref={noticeRef}
          tabIndex={-1}
          className={notice.severity === 'error' ? styles.error : styles.info}
          data-testid="import-notice"
          data-severity={notice.severity}
        >
          <p className={styles.noticeText}>{notice.message}</p>
          <div className={styles.noticeActions}>
            {notice.retry && onRetry ? (
              <Button variant="primary" onClick={onRetry}>
                {notice.severity === 'notice'
                  ? 'もう一度解析する'
                  : 'もう一度試す'}
              </Button>
            ) : null}
            {notice.severity === 'error' ? (
              <Button onClick={choose}>別のファイルを選ぶ</Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {file ? (
        <div className={styles.fileCard} data-testid="picked-file">
          <FileIcon />
          <div className={styles.fileText}>
            <p className={styles.fileName}>{file.name}</p>
            <p className={styles.muted}>
              {file.duration !== null
                ? `長さ ${formatClock(file.duration)}`
                : '長さは解析のときに確かめます'}
              {` ・ ${formatFileSize(file.size)}`}
            </p>
          </div>
          <Button onClick={choose}>ファイルを変える</Button>
        </div>
      ) : (
        <div
          className={over ? `${styles.drop} ${styles.dropOver}` : styles.drop}
          onDragOver={onDragOver}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="drop-zone"
        >
          <FileIcon large />
          <p className={styles.dropTitle}>音声ファイルをここにドロップ</p>
          <p className={styles.muted}>または</p>
          <Button variant="primary" onClick={choose}>
            ファイルを選ぶ
          </Button>
          <p className={styles.muted}>
            WAV・MP3・M4A の音声ファイル。10 分まで。
          </p>
        </div>
      )}

      <div className={styles.privacy}>
        <LockIcon />
        <div className={styles.privacyText}>
          <p className={styles.strong}>音はこの端末の外に出ません</p>
          <p className={styles.muted}>
            解析はこのブラウザの中だけで行います。送信も、Drive
            への保存もしません。ファイルと解析の結果は、この画面を閉じると消えます。
          </p>
        </div>
      </div>

      <section className={styles.what} aria-labelledby={whatId}>
        <h2 id={whatId} className={styles.h2}>
          できあがるもの
        </h2>
        <ul className={styles.list}>
          <li>テンポ・拍子・キー</li>
          <li>
            セクションと、コードだけの行（
            <span className={styles.mono}>
              |[C]--------|[C]----[F]----|
            </span>{' '}
            の形）
          </li>
          <li>
            自信のないコードには <span className={styles.mono}>?</span>{' '}
            の印と、ほかの候補
          </li>
        </ul>
        <p className={styles.muted}>
          歌詞とメロディは入りません。正確な書き起こしではなく、自分で直す前提の下書きです。自分やバンドで使うための、耳コピの補助としてお使いください。
        </p>
      </section>

      <div className={styles.footer}>
        <Button variant="primary" disabled={!file} onClick={onStart}>
          解析を始める
        </Button>
        <p className={styles.muted}>
          {file
            ? '曲名は次の画面で付けられます（初めは、ファイル名から付きます）。5 分の曲で 30 秒ほどかかります。'
            : 'ファイルを選ぶと押せます。5 分の曲で 30 秒ほどかかります。'}
        </p>
      </div>
    </div>
  );
}

function FileIcon({ large = false }: { large?: boolean }) {
  const size = large ? 40 : 32;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={styles.icon}
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M10 17v-5l4-1v5" />
      <circle cx="9" cy="17" r="1.2" />
      <circle cx="13" cy="16" r="1.2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={styles.lock}
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
