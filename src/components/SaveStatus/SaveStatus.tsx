import type { SaveState } from '../../lib/syncTypes';
import styles from './SaveStatus.module.css';

export type SaveStatusProps = {
  state: SaveState;
  /** false: not logged in (only changes the localOnly button). Default true. */
  signedIn?: boolean;
  /** Called by the button (the caller does the save / login). */
  onSave: () => void;
  /** Shown inside the button, e.g. 'Ctrl+S' or '⌘S'. Empty hides it. */
  shortcutLabel?: string;
};

/** 'HH:MM' in local time; '' when the ISO string is missing or invalid. */
function clock(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

type View = {
  tone: 'saved' | 'unconfirmed' | 'dirty' | 'saving' | 'failed' | 'local';
  label: string;
  sub: string;
  button: string;
  variant: 'quiet' | 'primary' | 'disabled' | 'danger';
};

function view(state: SaveState, signedIn: boolean): View {
  switch (state.kind) {
    case 'saved': {
      const t = clock(state.at);
      return {
        tone: 'saved',
        label: '保存済み',
        sub: t ? `${t} に Drive へ保存` : 'Drive へ保存',
        button: '保存',
        variant: 'quiet',
      };
    }
    case 'unconfirmed': {
      // Sign-in expired / offline: the cached copy, Drive not checked.
      const t = clock(state.at);
      return {
        tone: 'unconfirmed',
        label: '未確認',
        sub: t
          ? `${t} 保存の版（Drive の最新か未確認）`
          : 'Drive の最新か未確認',
        button: '保存',
        variant: 'quiet',
      };
    }
    case 'dirty': {
      const t = clock(state.draftAt);
      return {
        tone: 'dirty',
        label: '未保存の変更あり',
        sub: t ? `下書きは自動保存済み（${t}）` : '下書きは自動保存済み',
        button: '保存',
        variant: 'primary',
      };
    }
    case 'saving':
      return {
        tone: 'saving',
        label: '保存中…',
        sub: 'Drive に送っています',
        button: '保存中',
        variant: 'disabled',
      };
    case 'failed': {
      const why =
        state.reason === 'network'
          ? '通信できませんでした'
          : state.reason === 'auth'
            ? 'ログインの期限が切れました'
            : '保存できませんでした';
      return {
        tone: 'failed',
        label: '保存に失敗',
        sub: `${why}。下書きは残っています`,
        button: 'もう一度保存',
        variant: 'danger',
      };
    }
    case 'localOnly': {
      const t = clock(state.draftAt);
      return {
        tone: 'local',
        label: 'この端末だけに保存',
        sub: t ? `下書きは自動保存済み（${t}）` : '下書きは自動保存済み',
        button: signedIn ? '保存' : 'ログインして保存',
        variant: 'primary',
      };
    }
  }
}

/** Editor-header save status: dot + label + sub text, and the save button. */
export function SaveStatus({
  state,
  signedIn = true,
  onSave,
  shortcutLabel = 'Ctrl+S',
}: SaveStatusProps) {
  const v = view(state, signedIn);
  const disabled = state.kind === 'saving';
  return (
    <div className={styles.root} data-testid="save-status" data-state={v.tone}>
      <div className={styles.text} role="status" aria-live="polite">
        <span className={`${styles.label} ${styles[v.tone]}`}>
          <span className={styles.dot} aria-hidden="true" />
          {v.label}
        </span>
        <span className={styles.sub}>{v.sub}</span>
      </div>
      <button
        type="button"
        className={`${styles.button} ${styles[v.variant]}`}
        disabled={disabled}
        onClick={onSave}
      >
        {v.button}
        {shortcutLabel && !disabled && (
          <kbd className={styles.kbd}>{shortcutLabel}</kbd>
        )}
      </button>
    </div>
  );
}
