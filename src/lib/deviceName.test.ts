import { describe, expect, it } from 'vitest';
import { deviceName } from './deviceName';

const UA = {
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  ipados:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  cros: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
};

describe('deviceName', () => {
  it('detects iPad / iPhone', () => {
    expect(deviceName({ userAgent: UA.ipad })).toBe('iPad');
    expect(deviceName({ userAgent: UA.iphone })).toBe('iPhone');
  });
  it('treats a touch Mac UA as iPad (iPadOS 13+)', () => {
    expect(
      deviceName({
        userAgent: UA.ipados,
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe('iPad');
    expect(
      deviceName({
        userAgent: UA.ipados,
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe('Mac');
    expect(deviceName({ userAgent: UA.ipados })).toBe('Mac');
    expect(deviceName({ userAgent: UA.ipados, maxTouchPoints: 1 })).toBe('Mac');
  });
  it('distinguishes Android phone and tablet by Mobile token', () => {
    expect(deviceName({ userAgent: UA.androidPhone })).toBe('Android');
    expect(deviceName({ userAgent: UA.androidTablet })).toBe(
      'Android タブレット',
    );
  });
  it('detects Windows / Linux', () => {
    expect(deviceName({ userAgent: UA.windows })).toBe('Windows PC');
    expect(deviceName({ userAgent: UA.linux })).toBe('Linux PC');
  });
  it('does not call Android Linux, and ChromeOS / unknown fall back to PC', () => {
    expect(deviceName({ userAgent: UA.cros })).toBe('PC');
    expect(deviceName({ userAgent: '' })).toBe('PC');
    expect(deviceName({ userAgent: 'curl/8' })).toBe('PC');
  });
  it('falls back to platform when the UA is uninformative', () => {
    expect(deviceName({ userAgent: 'x', platform: 'Win32' })).toBe(
      'Windows PC',
    );
    expect(deviceName({ userAgent: 'x', platform: 'MacIntel' })).toBe('Mac');
    expect(deviceName({ userAgent: 'x', platform: 'Linux x86_64' })).toBe(
      'Linux PC',
    );
  });
});
