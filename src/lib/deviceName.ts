export function deviceName(env: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}): string {
  const ua = env.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) {
    return /Mobile/.test(ua) ? 'Android' : 'Android タブレット';
  }
  const platform = env.platform ?? '';
  const isMac = /Macintosh|Mac OS X/.test(ua) || /^Mac/.test(platform);
  // iPadOS 13+ Safari claims to be a Mac; real Macs have no multi-touch
  if (isMac) return (env.maxTouchPoints ?? 0) > 1 ? 'iPad' : 'Mac';
  if (/Windows/.test(ua) || /^Win/.test(platform)) return 'Windows PC';
  if (/CrOS/.test(ua)) return 'PC';
  if (/Linux|X11/.test(ua) || /^Linux/.test(platform)) return 'Linux PC';
  return 'PC';
}
