import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, type Route } from './route';

describe('parseRoute', () => {
  it('maps empty and root to list', () => {
    expect(parseRoute('')).toEqual({ screen: 'list' });
    expect(parseRoute('#')).toEqual({ screen: 'list' });
    expect(parseRoute('#/')).toEqual({ screen: 'list' });
  });
  it('maps legacy #view and unknown hashes to list', () => {
    expect(parseRoute('#view')).toEqual({ screen: 'list' });
    expect(parseRoute('#/foo')).toEqual({ screen: 'list' });
    expect(parseRoute('#/edit')).toEqual({ screen: 'list' });
    expect(parseRoute('#/edit/')).toEqual({ screen: 'list' });
    expect(parseRoute('#/edit/a/b')).toEqual({ screen: 'list' });
    expect(parseRoute('#/new/x')).toEqual({ screen: 'list' });
    expect(parseRoute('#/import/x')).toEqual({ screen: 'list' });
    expect(parseRoute('#import')).toEqual({ screen: 'list' });
  });
  it('parses the recording import', () => {
    expect(parseRoute('#/import')).toEqual({ screen: 'import' });
    expect(parseRoute(routeHash({ screen: 'import' }))).toEqual({
      screen: 'import',
    });
  });
  it('parses new / edit / view', () => {
    expect(parseRoute('#/new')).toEqual({ screen: 'new' });
    expect(parseRoute('#/edit/abc-1')).toEqual({
      screen: 'edit',
      songId: 'abc-1',
    });
    expect(parseRoute('#/view/abc-1')).toEqual({
      screen: 'view',
      songId: 'abc-1',
    });
  });
  it('accepts a hash without #', () => {
    expect(parseRoute('/edit/x')).toEqual({ screen: 'edit', songId: 'x' });
  });
  it('decodes escaped ids and falls back on malformed escapes', () => {
    expect(parseRoute('#/edit/a%2Fb%20c')).toEqual({
      screen: 'edit',
      songId: 'a/b c',
    });
    expect(parseRoute('#/edit/%E0%A4%A')).toEqual({ screen: 'list' });
  });
});

describe('routeHash', () => {
  it('builds hashes', () => {
    expect(routeHash({ screen: 'list' })).toBe('#/');
    expect(routeHash({ screen: 'new' })).toBe('#/new');
    expect(routeHash({ screen: 'import' })).toBe('#/import');
    expect(routeHash({ screen: 'edit', songId: 'abc' })).toBe('#/edit/abc');
    expect(routeHash({ screen: 'view', songId: 'abc' })).toBe('#/view/abc');
  });
  it('escapes special characters and round-trips', () => {
    const ids = ['a/b', 'a b', '日本語', 'x#y?z%', 'drive-1AbC_-'];
    for (const songId of ids) {
      for (const screen of ['edit', 'view'] as const) {
        const r: Route = { screen, songId };
        const h = routeHash(r);
        expect(h.slice(2 + screen.length + 1)).not.toMatch(/[/#?]/);
        expect(parseRoute(h)).toEqual(r);
      }
    }
  });
});
