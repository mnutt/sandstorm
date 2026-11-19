const sidebarKey = 'sandstorm.sidebar.collapsed';

// Device-local presentation preference, independent of account/session authority.
export function readSidebarCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(sidebarKey);
    return stored === null ? matchMedia('(max-width: 600px)').matches : stored === 'true';
  }
  catch { return false; }
}
export function saveSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(sidebarKey, String(collapsed)); }
  catch { /* Keep the control usable when browser storage is disabled. */ }
}
