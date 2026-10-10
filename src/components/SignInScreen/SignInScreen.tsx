import { Button } from '../Button/Button';
import styles from './SignInScreen.module.css';

export interface SignInScreenProps {
  /**
   * False when `VITE_GOOGLE_CLIENT_ID` is not set: the sign-in button is
   * replaced by a notice and the app works locally only.
   */
  configured: boolean;
  /** True while the Google popup is open (waiting for the user). */
  signingIn?: boolean;
  /** Shown above the button when sign-in failed (e.g. popup blocked). */
  error?: string;
  /** Start Google sign-in. Must be called from the click (popup rule). */
  onSignIn: () => void;
  /** 「ログインせずに編集を始める →」 (the caller routes to `#/new`). */
  onStartWithoutSignIn: () => void;
  /**
   * 「サンプル曲を追加（聖者の行進） →」: the caller makes a new song from
   * the built-in sample and opens it. No button when omitted.
   */
  onAddSample?: () => void;
}

const SCOPE_ITEMS = [
  {
    title: 'マイドライブの「band-sheets」フォルダ',
    body: '初回の保存時に自動で作られ、曲のファイルはすべてここに入ります。',
  },
  {
    title: 'このアプリが作ったファイルだけ',
    body: 'ほかのファイルやフォルダは、見えません。読み書きもできません。',
  },
  {
    title: 'メールやプロフィールの共有はしません',
    body: 'ログインの許可は「ドライブのファイル（このアプリ分）」だけです。',
  },
] as const;

/**
 * First screen for a user who never signed in and has no songs (M7 T11).
 * Presentational: the caller owns auth state and routing.
 */
export function SignInScreen({
  configured,
  signingIn = false,
  error,
  onSignIn,
  onStartWithoutSignIn,
  onAddSample,
}: SignInScreenProps) {
  return (
    <main className={styles.screen}>
      <section className={styles.card} aria-labelledby="signin-heading">
        <h1 id="signin-heading" className={styles.title}>
          曲を Google ドライブに保存して、
          <br />
          PC とタブレットで使う
        </h1>
        <p className={styles.lead}>
          ログインすると、編集した曲を自分の Google ドライブに保存できます。PC
          で作った曲を、タブレットでそのまま開けます。
        </p>

        {configured ? (
          <>
            <Button
              variant="primary"
              className={styles.signIn}
              onClick={onSignIn}
              disabled={signingIn}
            >
              {signingIn ? 'Google の画面を開いています…' : 'Google でログイン'}
            </Button>
            {signingIn && (
              <p role="status" className={styles.info}>
                Google の画面が別のウィンドウで開きます。「band-sheets
                に許可する」を選んでください。（ポップアップが出ないときは、ブロックを解除してください）
              </p>
            )}
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
          </>
        ) : (
          <p role="status" className={styles.notice}>
            Drive
            は設定されていません（docs/m7-google-setup.md）。ログインせずに、この端末だけで使えます。
          </p>
        )}

        <hr className={styles.rule} />
        <p className={styles.note}>
          <strong className={styles.noteStrong}>
            ログインしなくても使えます。
          </strong>
          <br />
          編集内容はこの端末のブラウザに自動で下書き保存されます。あとからログインして、Drive
          に保存できます。
        </p>
        <Button
          variant="ghost"
          className={styles.startLocal}
          onClick={onStartWithoutSignIn}
        >
          ログインせずに編集を始める →
        </Button>
        {onAddSample && (
          <Button
            variant="ghost"
            className={styles.startLocal}
            onClick={onAddSample}
          >
            サンプル曲を追加（聖者の行進） →
          </Button>
        )}
      </section>

      <aside className={styles.side} aria-label="ログインの説明">
        <section className={styles.panel} aria-labelledby="scope-heading">
          <h2 id="scope-heading" className={styles.panelTitle}>
            このアプリがさわれるもの
          </h2>
          <ul className={styles.scopeList}>
            {SCOPE_ITEMS.map((item) => (
              <li key={item.title} className={styles.scopeItem}>
                <span className={styles.scopeMark} aria-hidden="true" />
                <span>
                  <strong>{item.title}</strong>
                  <br />
                  <span className={styles.muted}>{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <p className={styles.revoke}>
          あとから許可を取り消すには、Google
          アカウントの「サードパーティのアプリとサービス」から band-sheets
          を削除します。Drive のファイルはそのまま残ります。
        </p>
      </aside>
    </main>
  );
}
