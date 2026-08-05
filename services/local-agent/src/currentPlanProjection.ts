import type { AgentPlan } from '@pinpawo/agent-session';

type DelegationSummary = {
  id: string;
  lane: string;
  task: string;
  status: 'pending' | 'progress' | 'completed';
};

type ActiveDelegation = {
  id: string;
  lane: string;
  task: string;
};

type RemainingPlanTask = {
  capability: string;
  task: string;
};

/**
 * Converts the authoritative orchestration state into the shared session
 * contract. The TUI never receives, parses, or infers a plan from synthetic
 * messages or delegation briefing content.
 */
export function projectCurrentPlan(state: unknown): AgentPlan | null {
  const record = asRecord(state);
  const active = readActiveDelegation(record?.taskActiveDelegation);
  if (!active) return null;

  const summaries = readDelegationSummaries(record?.runDelegationSummaries);
  const remaining = readRemainingPlan(record?.runCapabilityPlan);
  const activeInSummaries = summaries.some((summary) => summary.id === active.id);
  const completedOrPending = summaries.map((summary) => ({
    id: summary.id,
    capability: capabilityFromLane(summary.lane),
    task: summary.task,
    status: summary.id === active.id
      ? 'active' as const
      : summary.status === 'completed'
        ? 'completed' as const
        : 'pending' as const,
  }));

  if (!activeInSummaries) {
    completedOrPending.push({
      id: active.id,
      capability: capabilityFromLane(active.lane),
      task: active.task,
      status: 'active',
    });
  }

  return {
    items: [
      ...completedOrPending,
      ...remaining.map((item, index) => ({
        id: `pending:${item.capability}:${index}`,
        capability: item.capability,
        task: item.task,
        status: 'pending' as const,
      })),
    ],
  };
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

function readActiveDelegation(value: unknown): ActiveDelegation | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = readText(record.id);
  const lane = readText(record.lane);
  const task = readText(record.task);
  return id && lane && task ? { id, lane, task } : null;
}

function readDelegationSummaries(value: unknown): DelegationSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const id = readText(record?.id);
    const lane = readText(record?.lane);
    const task = readText(record?.task);
    const status = record?.status;
    if (
      !id
      || !lane
      || !task
      || (status !== 'pending' && status !== 'progress' && status !== 'completed')
    ) {
      return [];
    }
    return [{ id, lane, task, status }];
  });
}

function readRemainingPlan(value: unknown): RemainingPlanTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const capability = readText(record?.capability);
    const task = readText(record?.task);
    return capability && task ? [{ capability, task }] : [];
  });
}

function capabilityFromLane(lane: string) {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : lane;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
