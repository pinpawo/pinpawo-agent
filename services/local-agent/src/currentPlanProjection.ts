import type { AgentPlan } from '@pinpawo/agent-session';

/** Project business progress directly; execution messages are not another plan. */
export function projectCurrentPlan(state: unknown): AgentPlan | null {
  const supervisor = asRecord(asRecord(state)?.runSupervisorState);
  if (!Array.isArray(supervisor?.plan)) return null;
  const items = supervisor.plan.flatMap((value) => {
    const item = asRecord(value);
    const id = readIdentifier(item?.id);
    const capability = readDisplayText(item?.capability);
    const task = readDisplayText(item?.task);
    const status = item?.status;
    if (!id || !capability || !task || !['pending', 'executing', 'returned', 'completed'].includes(String(status))) return [];
    return [{ id, capability, task,
      status: status === 'completed' ? 'completed' as const
        : status === 'pending' ? 'pending' as const : 'active' as const }];
  });
  return items.length ? { items } : null;
}

export function currentPlansEqual(
  left: AgentPlan | null,
  right: AgentPlan | null,
) {
  if (left === right) return true;
  if (!left || !right || left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => {
    const other = right.items[index];
    return other !== undefined
      && item.id === other.id
      && item.capability === other.capability
      && item.task === other.task
      && item.status === other.status;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readIdentifier(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readDisplayText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
