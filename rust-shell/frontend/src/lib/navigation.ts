import { initialRoute, readRoute, routeKey, grainRoute, type Route } from './router';
import type { ShellState } from './model';

interface NavigationHooks {
  close: () => void;
  open: (grainId: string, path: string) => Promise<void>;
  changed: (route: Route, focus: boolean) => void;
}
export function isPlainNavigation(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

// Route intent is separate from connection recovery. A reconnect never replays
// an open; an explicit navigation, reload or Reopen action establishes intent.
export class NavigationController {
  route = initialRoute();
  private attempt = '';
  constructor(private hooks: NavigationHooks) {}
  navigate(path: string, pop = false) {
    this.hooks.close();
    if (!pop && location.pathname + location.search + location.hash !== path) history.pushState(null, '', path);
    this.route = readRoute();
    this.attempt = '';
    this.hooks.changed(this.route, true);
  }
  link(event: MouseEvent, path: string) {
    if (!isPlainNavigation(event)) return;
    event.preventDefault();
    this.navigate(path);
  }
  sync(model: ShellState) {
    const route = this.route;
    if (route.page === 'grain' && model.activeGrain?.grainId === route.grainId) this.attempt = routeKey(route);
    if (route.page !== 'grain' || model.status !== 'ready' || model.activeGrain || model.openingGrain || this.attempt === routeKey(route)) return;
    this.attempt = routeKey(route);
    void this.hooks.open(route.grainId, route.path);
  }
  reopen() {
    this.attempt = '';
    this.hooks.changed({ ...this.route }, false);
  }
  updatePath(grainId: string | undefined, path: string) {
    if (this.route.page !== 'grain' || this.route.grainId !== grainId) return;
    history.replaceState(null, '', grainRoute(grainId, path));
    this.route = readRoute();
    this.attempt = routeKey(this.route);
    this.hooks.changed(this.route, false);
  }
}
