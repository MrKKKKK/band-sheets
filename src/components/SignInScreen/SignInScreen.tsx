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
  /** 「新しい曲を作る →」 (the caller routes to `#/new`). */
  onStartWithoutSignIn: () => void;
  /**
   * 「サンプル曲で試す（聖者の行進）」 (primary): the caller makes a new song
   * from the built-in sample and opens it. When omitted, the primary button
   * is 「新しい曲を作る」 instead.
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
          バンドの楽譜を、パートごとに。
        </h1>
        <p className={styles.lead}>
          コード譜・メロディ・ドラムを書いて、タブレットで見ながら演奏できます。
        </p>

        <div className={styles.start}>
          <Button
            variant="primary"
            className={styles.primary}
            onClick={onAddSample ?? onStartWithoutSignIn}
          >
            {onAddSample ? 'サンプル曲で試す（聖者の行進）' : '新しい曲を作る'}
          </Button>
          {onAddSample && (
            <Button
              variant="ghost"
              className={styles.startLocal}
              onClick={onStartWithoutSignIn}
            >
              新しい曲を作る →
            </Button>
          )}
          <p className={styles.note}>
            ログインしなくても使えます。曲はこの端末のブラウザに保存されます。
          </p>
        </div>

        <hr className={styles.rule} />

        <section className={styles.drive} aria-labelledby="drive-heading">
          <h2 id="drive-heading" className={styles.driveTitle}>
            Google ドライブに保存する（任意）
          </h2>
          {configured ? (
            <>
              <p className={styles.driveText}>
                PC
                とタブレットで同じ曲を使えます。あとからでもログインできます。
              </p>
              <Button
                variant="secondary"
                className={styles.signIn}
                onClick={onSignIn}
                disabled={signingIn}
              >
                {signingIn
                  ? 'Google の画面を開いています…'
                  : 'Google でログイン'}
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
              <details className={styles.scope}>
                <summary className={styles.scopeSummary}>
                  このアプリがさわれるもの
                </summary>
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
                <p className={styles.revoke}>
                  あとから許可を取り消すには、Google
                  アカウントの「サードパーティのアプリとサービス」から
                  band-sheets を削除します。Drive のファイルはそのまま残ります。
                </p>
              </details>
            </>
          ) : (
            <p role="status" className={styles.notice}>
              Drive
              は設定されていません（docs/m7-google-setup.md）。ログインせずに、この端末だけで使えます。
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
