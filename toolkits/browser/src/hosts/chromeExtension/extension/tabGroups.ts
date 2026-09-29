/**
 * One Chrome tab group per Agent session's browser context (#867).
 *
 * The group is where a session's tabs live and how the user hands a tab to a
 * session: dragging a tab into the group grants that session its current
 * origin, dragging it out revokes the grant. A group is titled once, after
 * the site the session first opens ("🐾 github.com"), since the extension
 * never learns which conversation a context belongs to; colors rotate in
 * creation order, so two sessions on one site still look different.
 */

export type ContextGroup = Readonly<{
  groupId: number;
}>;

export type PersistedContextGroups = Readonly<{
  sequence: number;
  groups: Readonly<Record<string, ContextGroup>>;
}>;

const GROUP_COLORS = ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'red', 'yellow', 'grey'] as const;
export type ContextGroupColor = typeof GROUP_COLORS[number];

const GROUP_MARK = '🐾';
const MAX_CONTEXT_ID_LENGTH = 128;

/** The group title for a session on `url`: the paw mark and the site. */
export function contextGroupTitle(url: string | null | undefined): string {
  if (!url) return GROUP_MARK;
  try {
    const { protocol, hostname } = new URL(url);
    if ((protocol !== 'http:' && protocol !== 'https:') || !hostname) return GROUP_MARK;
    return `${GROUP_MARK} ${hostname.replace(/^www\./, '')}`;
  } catch {
    return GROUP_MARK;
  }
}

export function contextGroupColor(sequence: number): ContextGroupColor {
  return GROUP_COLORS[(Math.max(1, sequence) - 1) % GROUP_COLORS.length];
}

/** Reads the stored group map, dropping anything malformed. */
export function parsePersistedContextGroups(value: unknown): PersistedContextGroups {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const sequence = Number.isSafeInteger(record.sequence) && (record.sequence as number) > 0
    ? record.sequence as number
    : 0;
  const groups: Record<string, ContextGroup> = {};
  const stored = record.groups && typeof record.groups === 'object' && !Array.isArray(record.groups)
    ? record.groups as Record<string, unknown>
    : {};
  for (const [contextId, candidate] of Object.entries(stored)) {
    if (!contextId || contextId.length > MAX_CONTEXT_ID_LENGTH) continue;
    if (!candidate || typeof candidate !== 'object') continue;
    const { groupId } = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(groupId) || (groupId as number) < 0) continue;
    groups[contextId] = { groupId: groupId as number };
  }
  return { sequence, groups };
}

/** The context whose group this is, if any. */
export function contextForGroup(
  groups: ReadonlyMap<string, ContextGroup>,
  groupId: number,
): string | null {
  for (const [contextId, group] of groups) {
    if (group.groupId === groupId) return contextId;
  }
  return null;
}
