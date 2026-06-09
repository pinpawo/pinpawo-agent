import {
  buildReviewSpecFromHumanReviewRequest,
  type HumanReviewActionRequest,
  type HumanReviewConfig,
  type HumanReviewDecisionType,
  type HumanReviewRequest,
  type ReviewSpec,
} from '@pinpawo/pet-agent';

function readDecisionType(value: unknown): HumanReviewDecisionType | null {
  return value === 'approve' || value === 'edit' || value === 'reject' || value === 'respond'
    ? value
    : null;
}

function readHumanReviewActionRequest(value: unknown): HumanReviewActionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim()
    : typeof record.action === 'string' && record.action.trim()
      ? record.action.trim()
      : null;
  const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args)
    ? record.args as Record<string, unknown>
    : {};
  if (!name) return null;
  return {
    name,
    args,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

function readHumanReviewConfig(value: unknown): HumanReviewConfig | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const actionName = typeof record.actionName === 'string' && record.actionName.trim()
    ? record.actionName.trim()
    : null;
  const allowedDecisions = Array.isArray(record.allowedDecisions)
    ? record.allowedDecisions.flatMap((decision) => {
      const type = readDecisionType(decision);
      return type ? [type] : [];
    })
    : [];
  if (!actionName) return null;
  return {
    actionName,
    allowedDecisions,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

export function readPendingInterrupt(snapshot: { tasks?: unknown }): Record<string, unknown> | null {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (first && typeof first === 'object' && 'value' in first && first.value && typeof first.value === 'object') {
      return first.value as Record<string, unknown>;
    }
  }
  return null;
}

export function readHumanReviewActionRequests(interruptPayload: Record<string, unknown>) {
  return Array.isArray(interruptPayload.actionRequests)
    ? interruptPayload.actionRequests.filter((action): action is Record<string, unknown> =>
      Boolean(action && typeof action === 'object'),
    )
    : [];
}

export function isHumanReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return interruptPayload.kind === 'human_review'
    || (
      Array.isArray(interruptPayload.actionRequests)
      && Array.isArray(interruptPayload.reviewConfigs)
    );
}

export function readHumanReviewRequest(interruptPayload: Record<string, unknown>): HumanReviewRequest | null {
  if (!isHumanReviewInterruptPayload(interruptPayload)) {
    return null;
  }
  const actionRequests = Array.isArray(interruptPayload.actionRequests)
    ? interruptPayload.actionRequests.flatMap((action) => {
      const request = readHumanReviewActionRequest(action);
      return request ? [request] : [];
    })
    : [];
  const reviewConfigs = Array.isArray(interruptPayload.reviewConfigs)
    ? interruptPayload.reviewConfigs.flatMap((config) => {
      const reviewConfig = readHumanReviewConfig(config);
      return reviewConfig ? [reviewConfig] : [];
    })
    : [];

  return {
    kind: 'human_review',
    actionRequests,
    reviewConfigs,
    ...(typeof interruptPayload.prompt === 'string' ? { prompt: interruptPayload.prompt } : {}),
    ...(typeof interruptPayload.error === 'string' ? { error: interruptPayload.error } : {}),
  };
}

export function buildReviewSpecFromInterruptPayload(
  interruptPayload: Record<string, unknown>,
): ReviewSpec | undefined {
  const request = readHumanReviewRequest(interruptPayload);
  return request ? buildReviewSpecFromHumanReviewRequest(request) : undefined;
}

export function formatInterruptPrompt(interruptPayload: Record<string, unknown>) {
  if (typeof interruptPayload.prompt === 'string' && interruptPayload.prompt.trim()) {
    return interruptPayload.prompt.trim();
  }
  const descriptions = readHumanReviewActionRequests(interruptPayload).flatMap((action) => {
    if (typeof action.description === 'string' && action.description.trim()) {
      return [action.description.trim()];
    }
    const name = typeof action.name === 'string'
      ? action.name
      : typeof action.action === 'string'
        ? action.action
        : null;
    return name ? [`待审批动作：${name}`] : [];
  });
  return descriptions.length > 0
    ? descriptions.join('\n')
    : '当前流程需要你的确认，请直接回复继续或说明下一步。';
}

export function readShellReviewCommand(interruptPayload: Record<string, unknown>): string | null {
  if (interruptPayload.kind === 'confirm_shell' && typeof interruptPayload.command === 'string' && interruptPayload.command.trim()) {
    return interruptPayload.command.trim();
  }
  for (const action of readHumanReviewActionRequests(interruptPayload)) {
    const name = typeof action.name === 'string'
      ? action.name
      : typeof action.action === 'string'
        ? action.action
        : null;
    if (name !== 'shell' && name !== 'run_shell') continue;
    const args = action.args && typeof action.args === 'object'
      ? action.args as Record<string, unknown>
      : null;
    const command = args && typeof args.command === 'string' ? args.command.trim() : '';
    if (command) return command;
  }
  return null;
}

export function buildHumanReviewResume(decisions: Array<Record<string, unknown>>) {
  return { decisions };
}

function buildResumeFromUserText(message: string) {
  const text = message.trim();
  return buildHumanReviewResume([
    text
      ? { type: 'respond', message: text }
      : { type: 'reject' },
  ]);
}

function readFirstResumeDecisionType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  const first = decisions[0];
  if (!first || typeof first !== 'object') return null;
  const type = (first as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

export function normalizeInterruptResume(
  interruptPayload: Record<string, unknown>,
  message: string,
  explicitResume: unknown,
) {
  if (isHumanReviewInterruptPayload(interruptPayload)) {
    // Structured decisions take precedence. Otherwise treat the free-text
    // message as a `respond` decision (or `reject` if empty).
    return explicitResume !== undefined
      ? explicitResume
      : buildResumeFromUserText(message);
  }

  const explicitDecision = readFirstResumeDecisionType(explicitResume);
  if (explicitDecision === 'approve') {
    return { action: 'continue' };
  }
  if (explicitDecision === 'reject') {
    return { action: 'reject' };
  }
  return message;
}
