import { appPath, sharedRoute } from './router';
import { shareData } from './protocol';

export interface ShareGrant {
  id: string; label: string; role: string; kind: 'link' | 'person' | 'grain';
  recipientPictureUrl?: string;
  recipient: string; editable: boolean; inherited: boolean; created: string;
}
export interface SharingState {
  roles: { key: string; title: string; description: string }[];
  defaultRole: string; grants: ShareGrant[]; limited: boolean; owner: boolean; private: boolean;
}
export interface ShareChanges { label?: string; role?: string; revoked?: boolean }
export interface SharingActions {
  load(): Promise<SharingState>;
  create(label: string, role: string): Promise<string>;
  update(id: string, changes: ShareChanges): Promise<void>;
}
export interface SharingRequest { mode: 'share' | 'access'; path: string }
export function sharingRequest(mode: 'share' | 'access', value: unknown = {}): SharingRequest | undefined {
  const data = shareData(value);
  if (!data) return;
  const pathname = data.pathname || '/';
  // Validate the suffix independently, then append it to the fixed shared route.
  // Never resolve an app-provided URL against the shell origin.
  if (!pathname.startsWith('/') || pathname.includes('#') || pathname.includes('?')) return;
  const hash = data.hash ? (data.hash.startsWith('#') ? data.hash : '#' + data.hash) : '';
  const path = appPath(pathname + hash);
  return path ? { mode, path } : undefined;
}
export function sharingUrl(token: string, path: string): string {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(token)) throw new Error('Invalid sharing link.');
  return location.origin + sharedRoute(token, path);
}
