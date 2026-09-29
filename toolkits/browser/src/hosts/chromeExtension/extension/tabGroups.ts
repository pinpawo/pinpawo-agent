/**
 * One Chrome tab group per Agent session's browser context (#867).
 *
 * The group is where a session's tabs live and how the user hands a tab to a
 * session: dragging a tab into the group grants that session its current
 * origin, dragging it out revokes the grant. Groups are named by sequence
 * ("PinPawo 1", "PinPawo 2", …) with rotating colors, since the extension
 * never learns which conversation a context belongs to.
 */

export type ContextGroup = Readonly<{
  groupId: number;
  label: string;
}>;

export type PersistedContextGroups = Readonly<{
  sequence: number;
  groups: Readonly<Record<string, ContextGroup>>;
}>;

const GROUP_COLORS = ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'red', 'yellow', 'grey'] as const;
export type ContextGroupColor = typeof GROUP_COLORS[number];

const MAX_CONTEXT_ID_LENGTH = 128;

export function contextGroupLabel(sequence: number): string {
  return `PinPawo ${sequence}`;
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
    const { groupId, label } = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(groupId) || (groupId as number) < 0 || typeof label !== 'string') continue;
    groups[contextId] = { groupId: groupId as number, label };
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
