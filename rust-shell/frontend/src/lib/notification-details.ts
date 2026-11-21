import { ReportingPreference, type NotificationHandle$Client, type StatisticsDetails, type NotificationDetails as WireDetails } from '../generated/shell';
import type { ShellConnection } from './connection';
import { unwrap } from './results';

export type NotificationDetails =
  | {kind:'stats';enabled:boolean|null;sample:string}
  | {kind:'referrals';enabled:boolean;pending:{name:string;pictureUrl:string}[];completed:{name:string;pictureUrl:string}[]}
  | {kind:'identity'};
function statistics(value: StatisticsDetails): Extract<NotificationDetails,{kind:'stats'}> {
  const preference = value.preference;
  if (![ReportingPreference.UNSET, ReportingPreference.ENABLED, ReportingPreference.DISABLED].includes(preference)) throw new Error('Invalid reporting preference.');
  return {kind:'stats',enabled:preference === ReportingPreference.UNSET ? null : preference === ReportingPreference.ENABLED,sample:value.sample};
}
function details(value: WireDetails): NotificationDetails {
  if (value._isStatistics) return statistics(value.statistics);
  if (value._isIdentity) return {kind:'identity'};
  if (value._isReferrals) return {kind:'referrals',enabled:value.referrals.enabled,
    pending:[...value.referrals.pending].map(person=>({name:person.name,pictureUrl:person.pictureUrl})),
    completed:[...value.referrals.completed].map(person=>({name:person.name,pictureUrl:person.pictureUrl}))};
  throw new Error('Invalid notification details.');
}

/** The dialog owns this handle. Authority is rechecked server-side on every call. */
export class NotificationView {
  private closed = false;
  private client: NotificationHandle$Client;
  constructor(private connection: ShellConnection, key: string) {
    this.client = connection.shell.notification(p=>{p.key=key;}).getNotice();
  }
  private checkOpen() { if (this.closed) throw new Error('Notification view closed.'); }
  async read(): Promise<NotificationDetails> {
    this.checkOpen();
    const result = await this.connection.run(this.client.read().promise(), 'Load notification');
    this.checkOpen();
    return details(unwrap(result.result));
  }
  async setStatisticsReporting(enabled: boolean): Promise<Extract<NotificationDetails,{kind:'stats'}>> {
    this.checkOpen();
    const result = await this.connection.run(this.client.setStatisticsReporting(p=>{p.enabled=enabled;}).promise(), 'Save reporting preference');
    this.checkOpen();
    return statistics(unwrap(result.result));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.client.client.close();
  }
}
