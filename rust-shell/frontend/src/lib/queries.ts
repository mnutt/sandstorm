import {
  GrainObserver, NotificationObserver, GrainSort, GrainOwnership,
  type Subscription$Client,
} from '../generated/shell';
import type { ShellConnection } from './connection';
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
    void value.cancel().promise().catch(() => {}).finally(() => value.client.close());
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
  const observer = new GrainObserver.Server({replace: async params => {
    const grains = [...params.page.grains].map(grain => ({
      key: grain.key, title: grain.title, ownerTitle: grain.ownerTitle,
      href: grain.href, owned: grain.owned, lastUsed: grain.lastUsed,
      appTitle: grain.appTitle, appId: grain.appId, iconSrc: grain.iconSrc,
    }));
    changed(grains, params.page.hasMore);
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
  return observation(connection, request.promise(), () => observer.client.close(), failed);
}

export function watchNotifications(
  connection: ShellConnection,
  page: number,
  changed: (entries: Notification[], total: number) => void,
  failed: (error: unknown) => void,
) {
  const observer = new NotificationObserver.Server({replace: async params => {
    const entries = [...params.page.entries].map(entry => ({
      id: entry.key, title: entry.title, body: entry.body, href: entry.href,
      nativePath: entry.nativePath, nativeAction: entry.nativeAction,
      unread: entry.unread, ongoing: entry.ongoing, timestamp: entry.timestamp,
      senderName: entry.senderName, senderPictureUrl: entry.senderPictureUrl,
    }));
    changed(entries, params.page.total);
  }}).client();
  const request = connection.shell.watchNotifications(params => {
    params.page = page;
    params.observer = observer;
  });
  return observation(connection, request.promise(), () => observer.client.close(), failed);
}
