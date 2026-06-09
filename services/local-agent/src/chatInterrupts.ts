import {
  buildReviewSpecFromHumanReviewRequest,
  type AgentToolkit,
  type HumanReviewActionRequest,
  type HumanReviewConfig,
  type HumanReviewDecisionType,
  type HumanReviewRequest,
  type PendingReviewAction,
  type ReviewOption,
  type ReviewSpec,
} from '@pinpawo/pet-agent';

function readDecisionType(value: unknown): HumanReviewDecisionType | null {
  return value === 'approve' || value === 'edit' || value === 'reject' || value === 'respond'
    ? value
    : null;
}

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readReviewSpecValue(value: unknown): ReviewSpec | null {
  const record = readRecordValue(value);
  if (!record) return null;

  const id = readNonEmptyString(record.id);
  const schemaVersion = typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
    ? record.schemaVersion
    : null;
  const view = readRecordValue(record.view);
  const viewKind = view ? readNonEmptyString(view.kind) : null;
  const viewBody = view && typeof view.body === 'string' ? view.body : null;
  const options = Array.isArray(record.options) ? record.options : null;

  if (
    !id
    || schemaVersion == null
    || (viewKind !== 'plain' && viewKind !== 'markdown')
    || viewBody == null
    || !options
  ) {
    return null;
  }

  const validOptions = options.every((option) => {
    const optionRecord = readRecordValue(option);
    const decision = optionRecord ? readRecordValue(optionRecord.decision) : null;
    return Boolean(
      optionRecord
      && readNonEmptyString(optionRecord.id)
      && typeof optionRecord.label === 'string'
      && decision,
    );
  });

  return validOptions ? record as ReviewSpec : null;
}

function readPendingReviewActionValue(value: unknown): PendingReviewAction | null {
  const record = readRecordValue(value);
  if (!record) return null;
  const toolName = readNonEmptyString(record.toolName);
  const args = readRecordValue(record.args) ?? {};
  if (!toolName) return null;
  const actionId = readNonEmptyString(record.actionId) ?? 'pending_action';
  const description = readNonEmptyString(record.description);
  return {
    actionId,
    toolName,
    args,
    ...(description ? { description } : {}),
  };
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

function isReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return interruptPayload.kind === 'review'
    && Boolean(readReviewSpecValue(interruptPayload.review));
}

function isLegacyHumanReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return interruptPayload.kind === 'human_review'
    || (
      Array.isArray(interruptPayload.actionRequests)
      && Array.isArray(interruptPayload.reviewConfigs)
    );
}

export function isHumanReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return isReviewInterruptPayload(interruptPayload)
    || isLegacyHumanReviewInterruptPayload(interruptPayload);
}

export function readHumanReviewRequest(interruptPayload: Record<string, unknown>): HumanReviewRequest | null {
  if (!isLegacyHumanReviewInterruptPayload(interruptPayload)) {
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

export function readPendingReviewActionFromInterruptPayload(
  interruptPayload: Record<string, unknown>,
): PendingReviewAction | null {
  const directAction = readPendingReviewActionValue(interruptPayload.pendingAction);
  if (directAction) {
    return directAction;
  }

  const firstAction = readHumanReviewActionRequests(interruptPayload)[0] ?? null;
  if (!firstAction) {
    return null;
  }
  const args = readRecordValue(firstAction.args) ?? {};
  const toolName = readNonEmptyString(firstAction.name) ?? readNonEmptyString(firstAction.action);
  const description = readNonEmptyString(firstAction.description);
  return toolName
    ? {
        actionId: 'pending_action',
        toolName,
        args,
        ...(description ? { description } : {}),
      }
    : null;
}

function hasAuthorizationPolicy(toolkits: AgentToolkit[], toolName: string) {
  return toolkits.some((toolkit) =>
    Boolean(toolkit.policy?.toolReview?.[toolName]?.buildAuthorizationMatcher),
  );
}

function addAuthorizationOption(
  spec: ReviewSpec,
  request: HumanReviewRequest,
  toolkits: AgentToolkit[],
): ReviewSpec {
  const pendingAction = request.actionRequests.length === 1 ? request.actionRequests[0] : null;
  if (!pendingAction || !hasAuthorizationPolicy(toolkits, pendingAction.name)) {
    return spec;
  }
  if (spec.options.some((option) =>
    option.effects?.some((effect) => effect.type === 'graph.authorize_tool_action'),
  )) {
    return spec;
  }

  const approveIndex = spec.options.findIndex((option) => option.decision.type === 'approve');
  if (approveIndex < 0) {
    return spec;
  }

  const authorizeOption: ReviewOption = {
    id: 'approve-and-authorize-thread',
    label: 'Approve and authorize',
    description: 'Approve this action and authorize matching actions in this thread.',
    decision: { type: 'approve' },
    effects: [{
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    }],
  };
  return {
    ...spec,
    options: [
      ...spec.options.slice(0, approveIndex + 1),
      authorizeOption,
      ...spec.options.slice(approveIndex + 1),
    ],
  };
}

export function buildReviewSpecFromInterruptPayload(
  interruptPayload: Record<string, unknown>,
  options: { toolkits?: AgentToolkit[] } = {},
): ReviewSpec | undefined {
  const directReview = readReviewSpecValue(interruptPayload.review);
  if (directReview) {
    return directReview;
  }

  const request = readHumanReviewRequest(interruptPayload);
  if (!request) {
    return undefined;
  }
  const spec = buildReviewSpecFromHumanReviewRequest(request);
  return addAuthorizationOption(spec, request, options.toolkits ?? []);
}

export function formatInterruptPrompt(interruptPayload: Record<string, unknown>) {
  const directReview = readReviewSpecValue(interruptPayload.review);
  if (directReview) {
    return [
      directReview.view.title,
      directReview.view.body,
    ].filter((line): line is string => Boolean(line && line.trim())).join('\n')
      || '当前流程需要你的确认，请直接回复继续或说明下一步。';
  }

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
