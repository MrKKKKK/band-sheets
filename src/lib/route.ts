export type Route =
  | { screen: 'list' }
  | { screen: 'new' }
  | { screen: 'edit'; songId: string }
  | { screen: 'view'; songId: string };

const LIST: Route = { screen: 'list' };

/** '#view'（M6 のブックマーク）・空・不明・壊れた ID はすべて一覧に倒す */
export function parseRoute(hash: string): Route {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = body.split('/');
  if (parts[0] !== '') return LIST;
  if (parts[1] === 'new' && parts.length === 2) return { screen: 'new' };
  if ((parts[1] === 'edit' || parts[1] === 'view') && parts.length === 3) {
    let songId: string;
    try {
      songId = decodeURIComponent(parts[2]);
    } catch {
      return LIST;
    }
    if (songId === '') return LIST;
    return { screen: parts[1], songId };
  }
  return LIST;
}

export function routeHash(route: Route): string {
  switch (route.screen) {
    case 'list':
      return '#/';
    case 'new':
      return '#/new';
    case 'edit':
      return `#/edit/${encodeURIComponent(route.songId)}`;
    case 'view':
      return `#/view/${encodeURIComponent(route.songId)}`;
  }
}
