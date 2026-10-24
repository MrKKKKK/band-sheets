import { describe, expect, it } from 'vitest';
import {
  CSP_DIRECTIVES,
  CSP_META_RE,
  cspContent,
  injectCspMeta,
  parseCsp,
} from './csp';

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>t</title>
    <script type="module" src="/assets/index.js"></script>
  </head>
</html>`;

describe('CSP_DIRECTIVES', () => {
  const p = CSP_DIRECTIVES;

  it('allows no inline or eval script, and only the GIS library off-origin', () => {
    expect(p['script-src']).toEqual([
      "'self'",
      'https://accounts.google.com/gsi/client',
    ]);
    for (const sources of Object.values(p)) {
      expect(sources).not.toContain("'unsafe-eval'");
      expect(sources).not.toContain('*');
      expect(sources).not.toContain('data:');
      expect(sources).not.toContain('blob:');
    }
  });

  it('locks down plugins, base and forms', () => {
    expect(p['object-src']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'none'"]);
    expect(p['form-action']).toEqual(["'none'"]);
    expect(p['default-src']).toEqual(["'self'"]);
  });

  it('lets the token reach only Drive v3, GIS and the revoke endpoint', () => {
    expect(p['connect-src']).toEqual([
      "'self'",
      'https://www.googleapis.com/drive/v3/',
      'https://www.googleapis.com/upload/drive/v3/',
      'https://accounts.google.com/gsi/',
      'https://oauth2.googleapis.com/revoke',
    ]);
  });

  it('has no directive that a meta CSP ignores', () => {
    for (const d of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'])
      expect(p).not.toHaveProperty(d);
  });
});

describe('cspContent / parseCsp', () => {
  it('round-trips', () => {
    expect(parseCsp(cspContent())).toEqual(CSP_DIRECTIVES);
  });

  it('joins directives with "; "', () => {
    expect(cspContent({ a: ["'self'"], b: ['x', 'y'] })).toBe(
      "a 'self'; b x y",
    );
  });
});

describe('injectCspMeta', () => {
  it('puts the meta right after <meta charset>, before any script', () => {
    const out = injectCspMeta(PAGE);
    const meta = CSP_META_RE.exec(out);
    expect(meta?.[1]).toBe(cspContent());
    expect(out.indexOf('<meta charset')).toBeLessThan(meta!.index);
    expect(meta!.index).toBeLessThan(out.indexOf('<script'));
    expect(out.replace(/\n {4}<meta http-equiv[^\n]*/, '')).toBe(PAGE);
  });

  it('throws without <meta charset>, on a second CSP meta, on a quote', () => {
    expect(() => injectCspMeta('<head></head>')).toThrow(/charset/);
    expect(() => injectCspMeta(injectCspMeta(PAGE))).toThrow(/already/);
    expect(() => injectCspMeta(PAGE, 'a "b"')).toThrow(/quote/);
  });
});
