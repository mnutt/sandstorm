import { emptyProfile, type ProfileState } from './profile';
import type { CreationState } from './apps';

export interface Notification {
  nativePath: string;
  nativeAction: string;
  id: string;
  title: string;
  body: string;
  href: string;
  unread: boolean;
  ongoing: boolean;
  timestamp: string;
  senderName: string;
}
export interface Grain {
  appId: string;
  key: string;
  title: string;
  ownerTitle: string;
  iconSrc: string;
  href: string;
  owned: boolean;
  lastUsed: string;
  appTitle: string;
}
export interface AppAction {
  grainCount: number;
  shortDescription: string;
  appId: string;
  iconSrc: string;
  lastUsed: string;
  key: string;
  title: string;
  appTitle: string;
}
export interface ActiveGrain {
  path: string;
  grainId: string;
  origin: string;
  url: string;
  title: string;
  ownerTitle: string;
  iconSrc: string;
  mainHref: string;
}
export type ConnectionStatus = 'waiting' | 'connecting' | 'ready' | 'reconnecting' | 'stopped' | 'signed-out';
export interface ShellState {
  activeGrain: ActiveGrain | null;
  openGrains: ActiveGrain[];
  openingGrain: boolean;
  grains: Grain[];
  grainsLimited: boolean;
  status: ConnectionStatus;
  entries: Notification[];
  revision: number;
  connectionError: string;
  notificationError: string;
  grainError: string;
  pending: boolean;
  fixture: boolean;
  account: string | null;
  accountKey: string | null;
  total: number;
  creation: CreationState;
  profile: ProfileState;
}
export function initialShellState(): ShellState {
  return {
    profile: emptyProfile(), status: 'connecting', entries: [], grains: [], grainsLimited: false,
    activeGrain: null, openGrains: [], openingGrain: false, revision: 0,
    connectionError: '', notificationError: '', grainError: '', pending: false,
    fixture: true, account: null, accountKey:null, total: 0, creation: { status: 'idle' },
  };
}
