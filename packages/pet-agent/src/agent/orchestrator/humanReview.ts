
export type HumanReviewDecisionType = 'approve' | 'edit' | 'reject' | 'respond';

export type HumanReviewActionRequest = {
  name: string;
  args: Record<string, unknown>;
  description?: string;
};

export type HumanReviewConfig = {
  actionName: string;
  allowedDecisions: HumanReviewDecisionType[];
  description?: string;
};

export type HumanReviewRequest = {
  kind: 'human_review';
  actionRequests: HumanReviewActionRequest[];
  reviewConfigs: HumanReviewConfig[];
  prompt?: string;
  error?: string;
};

export type HumanReviewDecision =
  | { type: 'approve' }
  | { type: 'edit'; editedAction: HumanReviewActionRequest }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; message: string };

export function buildHumanReviewRequest(params: {
  actionRequests: HumanReviewActionRequest[];
  reviewConfigs: HumanReviewConfig[];
  prompt?: string | null;
  error?: string | null;
}): HumanReviewRequest {
  return {
    kind: 'human_review',
    actionRequests: params.actionRequests,
    reviewConfigs: params.reviewConfigs,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

export function buildHumanReviewResume(decisions: HumanReviewDecision[]) {
  return { decisions };
}

function readDecisionType(value: unknown): HumanReviewDecisionType | null {
  if (value !== 'approve' && value !== 'edit' && value !== 'reject' && value !== 'respond') {
    return null;
  }
  return value;
}

function readEditedAction(value: unknown): HumanReviewActionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim()
    ? record.name.trim()
    : null;
  const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args)
    ? record.args as Record<string, unknown>
    : null;
  if (!name || !args) return null;
  return {
    name,
    args,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

function readDecisionObject(value: unknown): HumanReviewDecision | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = readDecisionType(record.type ?? record.decision);
  if (!type) return null;

  if (type === 'approve') {
    return { type };
  }
  if (type === 'edit') {
    const editedAction = readEditedAction(record.editedAction ?? record.edited_action);
    return editedAction ? { type, editedAction } : null;
  }
  if (type === 'reject') {
    return {
      type,
      ...(typeof record.message === 'string' && record.message.trim()
        ? { message: record.message.trim() }
        : {}),
    };
  }

  const message = typeof record.message === 'string' ? record.message.trim() : '';
  return message ? { type, message } : null;
}

export function readFirstHumanReviewDecision(value: unknown): HumanReviewDecision | null {
  if (typeof value === 'boolean') {
    return value ? { type: 'approve' } : { type: 'reject' };
  }
  if (typeof value === 'string') {
    const message = value.trim();
    return message ? { type: 'respond', message } : null;
  }
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.decisions)) {
    return readDecisionObject(record.decisions[0]);
  }
  return readDecisionObject(record);
}
