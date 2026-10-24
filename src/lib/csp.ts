/**
 * Content-Security-Policy for the production build, delivered as
 * `<meta http-equiv="Content-Security-Policy">` because GitHub Pages cannot
 * set response headers. Injected by the `band-sheets:csp-meta` plugin in
 * vite.config.ts at build time only: the dev server needs inline scripts and
 * the HMR websocket, so `npm run dev` / Storybook / Vitest get no CSP.
 *
 * Defense in depth: the app has no known XSS sink (no innerHTML / eval /
 * dangerouslySetInnerHTML of user text), but the Google access token sits in
 * localStorage (`band-sheets:auth`), so a strict `script-src` and a narrow
 * `connect-src` limit what injected code could run and where it could send
 * the token.
 *
 * Sources (checked 2026-10-24):
 * - GIS CSP guidance, developers.google.com/identity/gsi/web/guides/get-google-api-clientid
 *   ("Content Security Policy"): script-src .../gsi/client, style-src .../gsi/style,
 *   connect-src and frame-src https://accounts.google.com/gsi/ (parent URL, not
 *   single endpoints).
 * - The GIS client script itself (accounts.google.com/gsi/client):
 *   `google.accounts.oauth2.revoke` POSTs to https://oauth2.googleapis.com/revoke
 *   (not covered by the guidance above); the token popup is `window.open`
 *   (not governed by CSP); the script injects an inline `<style>`.
 * - src/lib/drive/fetchDriveClient.ts: Drive v3 at /drive/v3/ and /upload/drive/v3/.
 * - alphaTab (PartScore / SectionScore): `core.useWorkers = false` and the
 *   player disabled, so no blob: Workers / audio; fonts come from Vite asset
 *   URLs (`?url`, same origin); it injects a `<style>` (alphaTabStyle) and
 *   SVG markup with `style` attributes.
 * - The analysis Workers (src/analysis/kinds.ts) are emitted as separate
 *   same-origin chunks (`assets/*.worker-*.js`), not blob:/data: URLs.
 *
 * Not usable in a meta CSP (ignored by browsers): frame-ancestors,
 * report-uri / report-to, sandbox.
 */

/** Directive → sources. Order is the order in the emitted policy. */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  // Fallback for everything not listed (manifest, media, prefetch…): own origin.
  'default-src': ["'self'"],
  // App chunks + the GIS library (exact file). No 'unsafe-inline' / 'unsafe-eval'.
  'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
  // 'unsafe-inline': injected <style> (Bravura @font-face, alphaTabStyle, GIS)
  // and style="" attributes in alphaTab's SVG markup. gsi/style per GIS guidance.
  'style-src': [
    "'self'",
    "'unsafe-inline'",
    'https://accounts.google.com/gsi/style',
  ],
  // @fontsource (Noto Sans JP, JetBrains Mono) and Bravura: built assets.
  'font-src': ["'self'"],
  // favicon.svg, icons.svg. No data:/remote images are used.
  'img-src': ["'self'"],
  // Drive v3 (metadata + alt=media, and uploads), GIS endpoints, token revoke.
  'connect-src': [
    "'self'",
    'https://www.googleapis.com/drive/v3/',
    'https://www.googleapis.com/upload/drive/v3/',
    'https://accounts.google.com/gsi/',
    'https://oauth2.googleapis.com/revoke',
  ],
  // GIS iframes (per guidance; the token popup itself is a window, not a frame).
  'frame-src': ['https://accounts.google.com/gsi/'],
  // The analysis module Workers (same-origin chunks). No blob:.
  'worker-src': ["'self'"],
  'object-src': ["'none'"],
  // Nothing uses <base> or submits a form to a URL (forms are onSubmit handlers).
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

/** The policy string for the meta tag's `content`. */
export function cspContent(
  directives: Readonly<Record<string, readonly string[]>> = CSP_DIRECTIVES,
): string {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
}

/** Parses a policy string back into directive → sources (for checks). */
export function parseCsp(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = sources;
  }
  return out;
}

export const CSP_META_RE =
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/;

/**
 * Inserts the CSP meta right after `<meta charset>` (a meta CSP only covers
 * what comes after it, so it must precede every script, style and link).
 * Throws if the page has no `<meta charset>` or already has a CSP meta.
 */
export function injectCspMeta(html: string, policy = cspContent()): string {
  if (/http-equiv=["']?Content-Security-Policy/i.test(html))
    throw new Error('injectCspMeta: the page already has a CSP meta');
  if (policy.includes('"'))
    throw new Error('injectCspMeta: the policy contains a double quote');
  const m = /<meta charset=[^>]*>/i.exec(html);
  if (!m) throw new Error('injectCspMeta: no <meta charset> in the page');
  const at = m.index + m[0].length;
  const tag = `\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`;
  return html.slice(0, at) + tag + html.slice(at);
}
