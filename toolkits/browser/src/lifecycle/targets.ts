/**
 * Managed Browser Target Registry.
 *
 * The Runtime owns the set of managed targets (agent-owned tabs, user-bound
 * tabs, and popups) rather than a single active tab. Target lifecycle is driven
 * by events; each target carries its own generation so a closed target can never
 * be resurrected by a late event.
 *
 * This is a pure in-memory registry with no Chrome/CDP I/O so it is unit-testable.
 */

export type TargetOwnership = 'agent' | 'user';

export type TargetRole = 'primary' | 'opener' | 'popup';

export type TargetState = 'opening' | 'open' | 'closing' | 'closed';

export type ManagedBrowserTarget = {
  targetId: string;
  tabId: number;
  windowId?: number;
  ownership: TargetOwnership;
  role: TargetRole;
  openerTargetId?: string;
  state: TargetState;
  url?: string;
  targetGeneration: number;
  navigationGeneration?: number;
};

export type TargetApplyEvent =
  | { kind: 'created'; targetId: string; tabId: number; ownership: TargetOwnership; role: TargetRole; windowId?: number; openerTargetId?: string; now: number }
  | { kind: 'updated'; patch: Partial<Pick<ManagedBrowserTarget, 'url' | 'windowId' | 'ownership' | 'navigationGeneration'>>; now?: number }
  | { kind: 'activated'; now?: number }
  | { kind: 'closing'; now: number }
  | { kind: 'closed'; now: number };

export class ManagedTargetRegistry {
  private readonly byId = new Map<string, ManagedBrowserTarget>();
  private readonly byTab = new Map<number, string>();
  private activeTargetId: string | null = null;

  /** Monotonic target generation counter, incremented on each mutation. */
  private generation = 0;

  list(): ManagedBrowserTarget[] {
    return [...this.byId.values()]
      .filter((target) => target.state !== 'closed')
      .map((target) => ({ ...target }));
  }

  active(): ManagedBrowserTarget | null {
    const target = this.activeTargetId ? this.byId.get(this.activeTargetId) : null;
    return target && target.state !== 'closed' ? { ...target } : null;
  }

  byTabId(tabId: number): ManagedBrowserTarget | null {
    const id = this.byTab.get(tabId);
    const target = id ? this.byId.get(id) : null;
    return target && target.state !== 'closed' ? { ...target } : null;
  }

  open(opts: {
    targetId?: string;
    tabId: number;
    ownership: TargetOwnership;
    role?: TargetRole;
    windowId?: number;
    openerTargetId?: string;
    url?: string;
  }): ManagedBrowserTarget {
    const targetId = opts.targetId ?? `target-${opts.tabId}-${this.nextTargetId()}`;
    this.generation += 1;
    const target: ManagedBrowserTarget = {
      targetId,
      tabId: opts.tabId,
      windowId: opts.windowId,
      ownership: opts.ownership,
      role: opts.role ?? 'primary',
      openerTargetId: opts.openerTargetId,
      state: 'opening',
      url: opts.url,
      targetGeneration: this.generation,
    };
    this.byId.set(targetId, target);
    this.byTab.set(opts.tabId, targetId);
    // A newly opened target becomes the active operation target.
    this.activeTargetId = targetId;
    return { ...target };
  }

  applyEvent(targetId: string, event: TargetApplyEvent): ManagedBrowserTarget {
    return this.mutate(targetId, event);
  }

  private mutate(targetId: string, event: TargetApplyEvent): ManagedBrowserTarget {
    const existing = this.byId.get(targetId);
    if (!existing) {
      throw new Error(`browser target ${targetId} does not exist in the managed registry`);
    }
    if (existing.state === 'closed') {
      // Closed targets are immutable; late events cannot resurrect them.
      throw new Error(`browser target ${targetId} is closed; late events are rejected`);
    }

    this.generation += 1;
    let next: ManagedBrowserTarget = { ...existing, targetGeneration: this.generation };

    switch (event.kind) {
      case 'created':
        next = { ...next, state: 'opening' };
        break;
      case 'updated': {
        next = {
          ...next,
          // An update confirms the target is live: an opening or closing target
          // becomes open; a fully closed target is rejected earlier.
          state: next.state === 'opening' || next.state === 'closing' ? 'open' : next.state,
          ...event.patch,
        };
        break;
      }
      case 'activated':
        this.activeTargetId = targetId;
        break;
      case 'closing':
        next = { ...next, state: 'closing' };
        break;
      case 'closed':
        next = { ...next, state: 'closed' };
        break;
    }

    this.byId.set(targetId, next);
    if (next.state === 'closed' || next.state === 'closing') {
      if (this.activeTargetId === targetId) this.activeTargetId = null;
    }
    return { ...next };
  }

  /**
   * When the active target closes, return to the live opener (or the newest
   * primary/opener that is still open) and activate it.
   */
  fallbackAfterClose(): ManagedBrowserTarget | null {
    const fallback = this.findFallbackTarget();
    if (!fallback) return null;
    this.activeTargetId = fallback.targetId;
    return { ...fallback };
  }

  private findFallbackTarget(): ManagedBrowserTarget | null {
    const closedActive = this.activeTargetId ? this.byId.get(this.activeTargetId) : null;
    if (closedActive?.openerTargetId) {
      const opener = this.byId.get(closedActive.openerTargetId);
      if (opener && opener.state !== 'closed') return opener;
    }
    // Prefer open primary/opener targets newest-first.
    const candidates = [...this.byId.values()].filter(
      (target) =>
        target.state === 'open'
        && (target.role === 'primary' || target.role === 'opener')
        && target.targetId !== closedActive?.targetId,
    );
    candidates.sort((a, b) => b.targetGeneration - a.targetGeneration);
    return candidates[0] ?? null;
  }

  private nextTargetId(): number {
    let candidate = Math.floor(Math.random() * 1_000_000);
    while (this.byId.has(`target-${candidate}`)) {
      candidate += 1;
    }
    return candidate;
  }
}
