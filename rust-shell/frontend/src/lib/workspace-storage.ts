import { appPath } from './router';
export interface SavedTab { id: string; path: string }
const key = (account:string, kind:'grains'|'shared') => `sandstorm.workspace.${kind}.${encodeURIComponent(account)}`;
export function readTabs(account:string, kind:'grains'|'shared'): SavedTab[] {
  try {
    const value:unknown = JSON.parse(sessionStorage.getItem(key(account,kind)) || '[]');
    if (!Array.isArray(value)) return [];
    const tabs = new Map<string,SavedTab>();
    for (const row of value) {
      if (row && typeof row.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(row.id) && typeof row.path === 'string' && appPath(row.path)) {
        tabs.set(row.id,{id:row.id,path:row.path});
      }
    }
    return [...tabs.values()];
  } catch { return []; }
}
export function saveTabs(account:string, kind:'grains'|'shared', tabs:SavedTab[]) {
  try { sessionStorage.setItem(key(account,kind),JSON.stringify(tabs)); } catch { /* Storage may be disabled. */ }
}
