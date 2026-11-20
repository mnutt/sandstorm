import type { PowerboxActions } from './powerbox-native';
import type { SharingActions } from './sharing';
import { GrainService } from './grains';
import type { ShellConnection } from './connection';
import type { ActiveGrain, Grain, ShellState } from './model';

interface Tab { service: GrainService; grain: ActiveGrain | null; opening: boolean }
// Mounted tabs own their session services. Selecting a route never transfers
// authority between tabs; app RPC callbacks always address their original tab.
export class GrainWorkspace {
  private tabs = new Map<string, Tab>();
  private selected: string | null = null;
  constructor(private connection: ShellConnection, private changed: (patch: Partial<ShellState>) => void) {}
  private publish() {
    const tab = this.selected ? this.tabs.get(this.selected) : undefined;
    this.changed({ activeGrain: tab?.grain ?? null, openingGrain: tab?.opening ?? false,
      openGrains: [...this.tabs.values()].flatMap(tab => tab.grain ? [tab.grain] : []) });
  }
  select(id: string | null) {
    this.selected = id;
    // An unfinished open is canceled on navigation; established tabs stay live.
    for (const [key, tab] of this.tabs) if (key !== id && tab.opening) {
      this.tabs.delete(key);
      tab.service.close();
    }
    this.publish();
  }
  reset() {
    const tabs = [...this.tabs.values()];
    for (const tab of tabs) tab.service.reset();
    this.tabs.clear();
    this.publish();
  }
  close(id = this.selected) {
    const tab = id ? this.tabs.get(id) : undefined;
    if (id) this.tabs.delete(id);
    tab?.service.close();
    this.publish();
  }
  async open(id: string, path: string, menu: Grain[]) {
    this.selected = id;
    if (this.tabs.has(id)) { this.publish(); return; }
    if (this.tabs.size >= 8) {
      this.changed({grainError:'Close a grain before opening another (8 open maximum).'});
      return;
    }
    const tab: Tab = { grain: null, opening: true, service: undefined! };
    tab.service = new GrainService(this.connection, patch => {
      if (this.tabs.get(id) !== tab) return;
      if ('activeGrain' in patch) tab.grain = patch.activeGrain ?? null;
      if ('openingGrain' in patch) tab.opening = !!patch.openingGrain;
      if (patch.grainError !== undefined) this.changed({grainError:patch.grainError});
      if (!tab.grain && !tab.opening) this.tabs.delete(id);
      this.publish();
    });
    this.tabs.set(id, tab);
    await tab.service.open(id, path, menu);
    if (!tab.grain && this.tabs.get(id) === tab) this.tabs.delete(id);
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
      update: (key, changes) => service.updateShare(key, changes) };
  }
  renderTemplate(id: string, input: unknown) { return this.service(id).renderTemplate(input); }
  private service(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('Grain session closed.');
    return tab.service;
  }
}
