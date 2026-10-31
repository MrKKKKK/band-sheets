import { describe, expect, it, vi } from 'vitest';
import { saveFile, type SaveFileEnv } from './saveFile';

function makeEnv() {
  const a = document.createElement('a');
  const click = vi.spyOn(a, 'click').mockImplementation(() => {});
  const pending: (() => void)[] = [];
  const env: SaveFileEnv = {
    createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn(),
    createAnchor: () => a,
    later: (fn) => pending.push(fn),
  };
  return { a, click, pending, env };
}

describe('saveFile', () => {
  it('clicks a download link with the name, then revokes the URL', () => {
    const { a, click, pending, env } = makeEnv();
    saveFile(new Blob(['x']), 'a.wav', env);
    expect(a.download).toBe('a.wav');
    expect(a.getAttribute('href')).toBe('blob:x');
    expect(click).toHaveBeenCalledOnce();
    expect(env.revokeObjectURL).not.toHaveBeenCalled();
    pending.forEach((f) => f());
    expect(env.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
  it('still revokes when the click throws', () => {
    const { click, pending, env } = makeEnv();
    click.mockImplementation(() => {
      throw new Error('x');
    });
    expect(() => saveFile(new Blob(), 'a.wav', env)).toThrow();
    pending.forEach((f) => f());
    expect(env.revokeObjectURL).toHaveBeenCalled();
  });
});
