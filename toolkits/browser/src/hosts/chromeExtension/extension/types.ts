export type JsonRecord = Record<string, unknown>;

export type BrowserTargetBinding = 'agent' | 'user';

export interface BrowserTarget {
  tabId: number;
  binding: BrowserTargetBinding;
}

export interface BrowserTabLike {
  id?: number;
  url?: string;
  pendingUrl?: string;
  status?: string;
  active?: boolean;
  openerTabId?: number;
}

export interface TargetBindOptions {
  resetHistory?: boolean;
  rememberCurrent?: boolean;
  userBoundOrigin?: string | null;
}
