import bravuraOtf from '@coderline/alphatab/font/Bravura.otf?url';
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url';

const STYLE_ID = 'bravura-font-face';

/**
 * Registers the Bravura SMuFL font as a CSS `@font-face` (family name
 * matches the `--font-music` token in theme.css), for components that draw
 * their own SVG/HTML and want music glyphs via plain CSS — e.g. a
 * hand-drawn melody staff rendering note heads, accidentals, clefs.
 *
 * Why this exists instead of a `url()` in a .css file: PartScore already
 * feeds alphaTab the same two font files via `settings.core.smuflFontSources`,
 * using Vite's `?url` asset import (`@coderline/alphatab/font/Bravura.woff2?url`),
 * which is proven to resolve correctly in dev, `npm run build`, and
 * Storybook (alphaTab renders with it today). A bare `url(@coderline/...)`
 * inside a CSS file depends on Vite's CSS asset resolver reaching into
 * node_modules the same way, which was not worth re-verifying across all
 * three environments when the JS-side import already does the job —
 * importing the same URLs here and injecting one `<style>` tag at runtime
 * is simplest-robust and reuses a path we already trust.
 *
 * Idempotent and safe to call from multiple components / mounts; only the
 * first call actually inserts the `<style>` element.
 */
export function injectBravuraFontFace(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
@font-face {
  font-family: 'Bravura';
  src: url('${bravuraWoff2}') format('woff2'), url('${bravuraOtf}') format('opentype');
  font-display: block;
}
`;
  document.head.appendChild(style);
}
