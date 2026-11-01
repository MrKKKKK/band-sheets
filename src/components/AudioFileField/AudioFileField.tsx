import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from 'react';
import { formatClock, formatFileSize } from '../../lib/import/format';
import { Button } from '../Button/Button';
import styles from './AudioFileField.module.css';

export interface PickedFile {
  name: string;
  size: number;
  /** Seconds; null = not known before decoding. */
  duration: number | null;
  /** The length is being read: show it, and keep the start button off. */
  probing?: boolean;
}

export type AudioFileFieldProps = {
  file: PickedFile | null;
  onPick: (file: File) => void;
  /** The hidden file input: the caller may open the file dialog with `.click()` (e.g. 「別のファイルを選ぶ」). */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Text under the drop zone. */
  hint: string;
};

const ACCEPT = 'audio/*,.wav,.mp3,.m4a';

/**
 * The audio file picker shared by the import screens (S1 / S2): a drop zone with 「ファイルを選ぶ」, or the
 * picked file's card with 「ファイルを変える」. A file dropped anywhere on the page is taken as the new file
 * (the screen stops the browser from opening it: hooks/usePageDropGuard).
 */
export function AudioFileField({
  file,
  onPick,
  inputRef,
  hint,
}: AudioFileFieldProps) {
  const [over, setOver] = useState(false);
  const choose = () => inputRef.current?.click();

  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });
  useEffect(() => {
    const onDrop = (e: globalThis.DragEvent) => {
      setOver(false);
      const f = e.dataTransfer?.files[0];
      if (f) onPickRef.current(f);
    };
    window.addEventListener('drop', onDrop);
    return () => window.removeEventListener('drop', onDrop);
  }, []);
  const onDragOver = (e: DragEvent) => {
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  };

  return (
    <>
      <input
        ref={inputRef}
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
      {file ? (
        <div className={styles.fileCard} data-testid="picked-file">
          <FileIcon />
          <div className={styles.fileText}>
            <p className={styles.fileName}>{file.name}</p>
            <p className={styles.muted}>
              {file.probing
                ? '長さを調べています'
                : file.duration !== null
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
          data-testid="drop-zone"
        >
          <FileIcon large />
          <p className={styles.dropTitle}>音声ファイルをここにドロップ</p>
          <p className={styles.muted}>または</p>
          <Button variant="primary" onClick={choose}>
            ファイルを選ぶ
          </Button>
          <p className={styles.muted}>{hint}</p>
        </div>
      )}
    </>
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
