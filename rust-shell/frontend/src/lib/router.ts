export type Route = { page: 'notifications' | 'grains' | 'apps' | 'missing' } | { page: 'grain'; grainId: string; path: string };
export function appPath(value: string): string | null {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const url = new URL(value, 'https://app.invalid');
  return url.origin === 'https://app.invalid' ? url.pathname + url.search + url.hash : null;
}
export function readRoute(url = new URL(location.href)): Route {
  if (url.pathname === '/' || url.pathname === '/notifications') return { page: 'notifications' };
  if (url.pathname === '/grains') return { page: 'grains' };
  if (url.pathname === '/apps') return { page: 'apps' };
  const match = url.pathname.match(/^\/grain\/([^/]+)(\/.*)?$/);
  if (match) {
    let id;
    try { id = decodeURIComponent(match[1]); } catch { return { page: 'missing' }; }
    const path = appPath((match[2] || '/') + url.search + url.hash);
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(id) && path) return { page: 'grain', grainId: id, path };
  }
  return { page: 'missing' };
}
export function grainRoute(id: string, path = '/') { return '/grain/' + encodeURIComponent(id) + (path === '/' ? '' : path); }
export function routeKey(route: Route) { return route.page === 'grain' ? grainRoute(route.grainId, route.path) : '/' + route.page; }
const returnKey = 'rustShellReturnRoute';
export function rememberRoute() {
  const route = readRoute();
  if (route.page === 'missing') return;
  try { sessionStorage.setItem(returnKey, JSON.stringify({ path: routeKey(route), expires: Date.now() + 300000 })); } catch {}
}
export function initialRoute() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey) || 'null');
    sessionStorage.removeItem(returnKey);
    if (location.pathname === '/' && saved?.expires > Date.now() && typeof saved.path === 'string' && saved.path.startsWith('/') && !saved.path.startsWith('//')) {
      const url = new URL(saved.path, location.origin);
      if (url.origin === location.origin && readRoute(url).page !== 'missing') history.replaceState(null, '', saved.path);
    }
  } catch {}
  return readRoute();
}
