import { GrainDisposition } from '../generated/shell';
import { grainDisposition } from './grain-management';
import { readTabs, saveTabs } from './workspace-storage';
import type { PowerboxActions } from './powerbox-native';
import type { SharingActions } from './sharing';
import { GrainService } from './grains';
import type { ShellConnection } from './connection';
import type { ActiveGrain, Grain, ShellState } from './model';

interface Tab { service: GrainService; grain: ActiveGrain | null; opening: boolean; background: boolean }
// Mounted tabs own their session services. Selecting a route never transfers
// authority between tabs; app RPC callbacks always address their original tab.
export class GrainWorkspace {
  private tabs = new Map<string, Tab>();
  private selected: string | null = null;
  private account: string | null = null;
  private saved = new Map<string,string>();
  private restorePending = false;
  private generation = 0;
  selectAccount(account:string | null) {
    if (account === this.account) return;
    this.reset();
    this.account = account;
    this.saved = new Map(account ? readTabs(account,'grains').map(tab=>[tab.id,tab.path]) : []);
    this.restorePending = !!account;
  }
  restore(menu:Grain[], current?:string) {
    if (!this.restorePending) return;
    this.restorePending = false;
    for (const [id,path] of this.saved) if (id !== current) void this.open(id,path,menu,true);
  }
  private persist() {
    if (this.account) saveTabs(this.account,'grains',[...this.saved].map(([id,path])=>({id,path})));
  }
  constructor(private connection: ShellConnection, private changed: (patch: Partial<ShellState>) => void) {}
  private publish() {
    const tab = this.selected ? this.tabs.get(this.selected) : undefined;
    this.changed({ activeGrain: tab?.grain ?? null, openingGrain: tab?.opening ?? false,
      openGrains: [...this.saved.keys()].flatMap(id => { const grain=this.tabs.get(id)?.grain; return grain ? [grain] : []; }) });
  }
  select(id: string | null) {
    this.selected = id;
    // An unfinished open is canceled on navigation; established tabs stay live.
    for (const [key, tab] of this.tabs) if (key !== id && tab.opening && !tab.background) {
      this.tabs.delete(key);
      tab.service.close();
    }
    this.publish();
  }
  reset() {
    ++this.generation;
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    for (const tab of tabs) tab.service.reset();
    this.publish();
  }
  close(id = this.selected) {
    const tab = id ? this.tabs.get(id) : undefined;
    if (id) { this.tabs.delete(id); this.saved.delete(id); this.persist(); }
    tab?.service.close();
    this.publish();
  }
  async open(id: string, path: string, menu: Grain[], background = false) {
    if (!background) this.selected = id;
    if (this.tabs.has(id)) { this.publish(); return; }
    const generation = this.generation;
    const tab: Tab = { grain: null, opening: true, background, service: undefined! };
    tab.service = new GrainService(this.connection, patch => {
      if (this.tabs.get(id) !== tab) return;
      const wasLive = !!tab.grain;
      if ('activeGrain' in patch) tab.grain = patch.activeGrain ?? null;
      if ('openingGrain' in patch) tab.opening = !!patch.openingGrain;
      if (patch.grainError !== undefined) this.changed({grainError:patch.grainError});
      if (tab.grain && this.saved.get(id) !== tab.grain.path) { this.saved.set(id,tab.grain.path); this.persist(); }
      if (!tab.grain && !tab.opening) {
        this.tabs.delete(id);
        if (wasLive && !this.connection.signal?.aborted) void grainDisposition(this.connection,id).then(state=>{
          if (generation === this.generation && !this.tabs.has(id) && state !== GrainDisposition.ACTIVE) {
            this.saved.delete(id); this.persist();
          }
        }).catch(()=>{});
      }
      this.publish();
    });
    this.tabs.set(id, tab);
    await tab.service.open(id, path, menu);
    if (!tab.grain && this.tabs.get(id) === tab) this.tabs.delete(id);
    if (!tab.grain && generation === this.generation && this.account && this.saved.has(id) && !this.tabs.has(id)) {
      // Denied or deleted grains should not be attempted on every reload.
      this.saved.delete(id); this.persist();
    }
  }
  applyMenu(menu: Grain[]) { for (const tab of this.tabs.values()) tab.service.applyMenu(menu); }
  pathChanged(id: string, path: string) {
    const tab = this.tabs.get(id);
    tab?.service.pathChanged(path);
  }
  rename(id: string, title: string) { return this.service(id).rename(title); }
  powerbox(id: string): PowerboxActions {
    const service = this.service(id);
    return { call: (request, operation, input) => service.powerbox(request, operation, input) };
  }
  sharing(id: string): SharingActions {
    const service = this.service(id);
    return { load: () => service.sharingState(), create: (label, role) => service.createShare(label, role),
      edit: (key, label, role) => service.editShare(key, label, role), revoke: key => service.revokeShare(key) };
  }
  renderTemplate(id: string, input: unknown) { return this.service(id).renderTemplate(input); }
  private service(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('Grain session closed.');
    return tab.service;
  }
}
