import { useId, useRef, type Ref } from 'react';
import type { ImportNotice } from '../../lib/import/importErrors';
import {
  AudioFileField,
  type PickedFile,
} from '../AudioFileField/AudioFileField';
import { Button } from '../Button/Button';
import styles from './ImportPicker.module.css';

export type { PickedFile };

export type ImportPickerProps = {
  file: PickedFile | null;
  /** Shown above the file picker (plan §6.2; texts from importErrors.ts). */
  notice?: ImportNotice | null;
  onPick: (file: File) => void;
  /** 「解析を始める」, and also 「もう一度試す」 / 「もう一度解析する」 (same file). */
  onStart: () => void;
  /** The notice box (focused by the screen when a notice appears). */
  noticeRef?: Ref<HTMLDivElement>;
};

/** S1 「録音から新しい曲」 before / between analyses: pick a file, read what happens, start. */
export function ImportPicker({
  file,
  notice,
  onPick,
  onStart,
  noticeRef,
}: ImportPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const whatId = useId();
  const choose = () => input.current?.click();

  return (
    <div className={styles.picker}>
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
            {notice.retry ? (
              <Button variant="primary" onClick={onStart}>
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

      <AudioFileField
        file={file}
        onPick={onPick}
        inputRef={input}
        hint="WAV・MP3・M4A の音声ファイル。10 分まで。"
      />

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
        <Button
          variant="primary"
          disabled={!file || file.probing}
          onClick={onStart}
        >
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
