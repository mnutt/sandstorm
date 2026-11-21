export type Route = { page: 'install'; packageId?: string; url: string } | { page: 'apps'; appId?: string } | { page: 'notifications' | 'grains' | 'trash' | 'account' | 'login' | 'oauth-complete' | 'missing' } | { page: 'grain'; grainId: string; path: string } | { page: 'shared'; webkey: string; path: string };
export function appPath(value: string): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const url = new URL(value, 'https://app.invalid');
  return url.origin === 'https://app.invalid' ? url.pathname + url.search + url.hash : null;
}
export function readRoute(url = new URL(location.href)): Route {
  if (url.pathname === '/' || url.pathname === '/notifications') return { page: 'notifications' };
  if (url.pathname === '/trash') return { page: 'trash' };
  if (url.pathname === '/grains') return { page: 'grains' };
  if (url.pathname === '/oauth-complete') return {page:'oauth-complete'};
  if (url.pathname === '/login') return {page:'login'};
  if (url.pathname === '/account') return { page: 'account' };
  if (url.pathname === '/install') return { page: 'install', url: '' };
  const install = url.pathname.match(/^\/install\/([a-f0-9]{32})\/?$/);
  if (install) return { page: 'install', packageId: install[1], url: url.searchParams.get('url') || '' };
  if (url.pathname === '/apps') return { page: 'apps' };
  const app = url.pathname.match(/^\/apps\/([a-zA-Z0-9_-]{1,128})\/?$/);
  if (app) return { page: 'apps', appId: app[1] };
  const shared = url.pathname.match(/^\/shared\/([a-zA-Z0-9_-]{1,256})(\/.*)?$/);
  if (shared) {
    const path = appPath((shared[2] || '/') + url.search + url.hash);
    if (path) return {page:'shared',webkey:shared[1],path};
  }
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
export function sharedRoute(webkey:string,path='/') { return '/shared/' + encodeURIComponent(webkey) + (path === '/' ? '' : path); }
export function appRoute(id: string) { return '/apps/' + encodeURIComponent(id); }
export function installRoute(id: string, url = '') { return '/install/' + encodeURIComponent(id) + (url ? '?url=' + encodeURIComponent(url) : ''); }
export function routeKey(route: Route) { return route.page === 'install' ? (route.packageId ? installRoute(route.packageId,route.url) : '/install') : route.page === 'apps' && route.appId ? appRoute(route.appId) : route.page === 'shared' ? sharedRoute(route.webkey,route.path) : route.page === 'grain' ? grainRoute(route.grainId, route.path) : '/' + route.page; }
const returnKey = 'rustShellReturnRoute';
export function rememberRoute() {
  const route = readRoute();
  if (route.page === 'missing' || route.page === 'login' || route.page === 'oauth-complete') return;
  try { sessionStorage.setItem(returnKey, JSON.stringify({ path: routeKey(route), expires: Date.now() + 300000 })); } catch {}
}
export function initialRoute() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(returnKey) || 'null');
    if (location.pathname === '/' || saved?.expires <= Date.now()) sessionStorage.removeItem(returnKey);
    if (location.pathname === '/' && saved?.expires > Date.now() && typeof saved.path === 'string' && saved.path.startsWith('/') && !saved.path.startsWith('//')) {
      const url = new URL(saved.path, location.origin);
      if (url.origin === location.origin && readRoute(url).page !== 'missing') history.replaceState(null, '', saved.path);
    }
  } catch {}
  return readRoute();
}

// Only destinations implemented for notifications can bypass the legacy shell.
export function notificationDestination(path: string): {path:string;label:string} | null {
  if (!path || appPath(path) !== path) return null;
  const route = readRoute(new URL(path, 'https://shell.invalid'));
  if (route.page === 'grain') return {path,label:'Open grain'};
  if (path === '/install') return {path,label:'Review updates'};
  return null;
}
