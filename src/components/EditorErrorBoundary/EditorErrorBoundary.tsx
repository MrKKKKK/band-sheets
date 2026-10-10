import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../Button/Button';
import styles from './EditorErrorBoundary.module.css';

export interface EditorErrorBoundaryProps {
  children: ReactNode;
  /**
   * Any value that changes when the content may have been fixed (App passes
   * the song text): after a crash, a new value re-renders the children.
   */
  resetKey: unknown;
  /** Shown as a 「テキスト入力で確認する」 button in the fallback. */
  onRequestTextEdit?: () => void;
}

interface State {
  failed: boolean;
  resetKey: unknown;
}

/** The fallback's message (exported for tests). */
export const EDITOR_CRASH_MESSAGE =
  'この画面を表示できませんでした。テキスト入力で内容を確認してください。';

/**
 * Per-editor-tab error boundary (m5-review.md R1): a rendering exception in
 * one editor tab shows a Japanese message there instead of unmounting the
 * whole app (App keeps every tab panel mounted, so without this a crash in
 * a hidden tab blanked everything). Recovers by itself when `resetKey`
 * changes (e.g. the text was fixed in テキスト入力), or via 「もう一度表示する」.
 */
export class EditorErrorBoundary extends Component<
  EditorErrorBoundaryProps,
  State
> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: EditorErrorBoundaryProps,
    state: State,
  ): Partial<State> | null {
    return props.resetKey !== state.resetKey
      ? { failed: false, resetKey: props.resetKey }
      : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('editor crashed', error, info.componentStack);
  }

  private retry = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    const { onRequestTextEdit } = this.props;
    return (
      <div className={styles.fallback} data-testid="editor-crash">
        <p className={styles.message} role="alert">
          {EDITOR_CRASH_MESSAGE}
        </p>
        <div className={styles.actions}>
          {onRequestTextEdit && (
            <Button variant="primary" onClick={onRequestTextEdit}>
              テキスト入力で確認する
            </Button>
          )}
          <Button onClick={this.retry}>もう一度表示する</Button>
        </div>
      </div>
    );
  }
}
