import { ListCache } from './list-delta';
import {
  GrainObserver, NotificationObserver, GrainSort, GrainOwnership,
  type Subscription$Client,
} from '../generated/shell';
import type { ShellConnection } from './connection';
import { unwrap, applicationErrorMessage } from './results';
import type { Grain, Notification } from './model';

export interface GrainQuery {
  search: string;
  appId: string;
  sort: 'recent' | 'title';
  ownership: 'all' | 'owned' | 'shared';
  page: number;
}

function observation<T extends {subscription: Subscription$Client}>(
  connection: ShellConnection,
  request: PromiseLike<T>,
  releaseObserver: () => void,
  failed: (error: unknown) => void,
) {
  let closed = false;
  let subscription: Subscription$Client | undefined;
  const release = (value: Subscription$Client) => {
    void connection.run(value.cancel().promise(), 'Stop list observation').catch(() => {}).finally(() => value.client.close());
  };
  void connection.run(request, 'Observe list', {
    onLateResult: result => release(result.subscription),
  }).then(result => {
    if (closed) {
      release(result.subscription);
      return;
    }
    subscription = result.subscription;
    void subscription.whenClosed().promise().then(
      () => { if (!closed) failed(new Error('List observation ended')); },
      error => { if (!closed) failed(error); },
    );
  }).catch(error => { if (!closed) failed(error); });
  return () => {
    closed = true;
    if (subscription) release(subscription);
    releaseObserver();
  };
}

export function watchGrains(
  connection: ShellConnection,
  query: GrainQuery,
  changed: (grains: Grain[], more: boolean) => void,
  failed: (error: unknown) => void,
) {
  let stopped = false;
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    failed(new Error(applicationErrorMessage(error, 'Could not update the grain list. Please reconnect.')));
  };
  const cache = new ListCache<Grain>(row => row.key);
  const observer = new GrainObserver.Server({update: async params => {
    if (stopped) return;
    try {
      const page = unwrap(params.result);
      const grains = cache.apply(page.delta, [...page.upserts].map(grainRow));
      changed(grains, page.hasMore);
    } catch (error) { fail(error); }
  }}).client();
  const request = connection.shell.watchGrains(params => {
    const value = params._initQuery();
    value.search = query.search;
    value.appId = query.appId;
    value.page = query.page;
    value.sort = query.sort === 'title' ? GrainSort.TITLE : GrainSort.RECENT;
    value.ownership = {owned: GrainOwnership.OWNED, shared: GrainOwnership.SHARED, all: GrainOwnership.ALL}[query.ownership];
    params.observer = observer;
  });
  const stop = observation(connection, request.promise(), () => observer.client.close(), fail);
  return () => { stopped = true; stop(); };
}

export function watchNotifications(
  connection: ShellConnection,
  page: number,
  changed: (entries: Notification[], total: number) => void,
  failed: (error: unknown) => void,
) {
  let stopped = false;
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    failed(new Error(applicationErrorMessage(error, 'Could not update notifications. Please reconnect.')));
  };
  const cache = new ListCache<Notification>(row => row.id);
  const observer = new NotificationObserver.Server({update: async params => {
    if (stopped) return;
    try {
      const page = unwrap(params.result);
      const entries = cache.apply(page.delta, [...page.upserts].map(notificationRow));
      changed(entries, page.total);
    } catch (error) { fail(error); }
  }}).client();
  const request = connection.shell.watchNotifications(params => {
    params.page = page;
    params.observer = observer;
  });
  const stop = observation(connection, request.promise(), () => observer.client.close(), fail);
  return () => { stopped = true; stop(); };
}

export const grainRow = (grain: import('../generated/shell').Grain): Grain => ({
  key: grain.key, title: grain.title, ownerTitle: grain.ownerTitle,
  href: grain.href, owned: grain.owned, lastUsed: grain.lastUsed,
  appTitle: grain.appTitle, appId: grain.appId, iconSrc: grain.iconSrc,
});

export const notificationRow = (entry: import('../generated/shell').Notification): Notification => ({
  id: entry.key, title: entry.title, body: entry.body, href: entry.href,
  nativePath: entry.nativePath, nativeAction: entry.nativeAction,
  unread: entry.unread, ongoing: entry.ongoing, timestamp: entry.timestamp,
  senderName: entry.senderName, senderPictureUrl: entry.senderPictureUrl,
});
