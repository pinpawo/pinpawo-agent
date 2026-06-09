import { randomUUID } from 'node:crypto';
import type {
  HumanReviewActionRequest,
  HumanReviewDecisionType,
  HumanReviewRequest,
} from '../humanReview';
import type {
  ReviewOption,
  ReviewOptionDecision,
  ReviewSpec,
} from './reviewSpec';

const DEFAULT_REVIEW_BODY = 'This action requires human review.';
const DECISION_ORDER: HumanReviewDecisionType[] = ['approve', 'reject', 'respond', 'edit'];

export type BuildReviewSpecFromHumanReviewRequestOptions = {
  id?: string;
  schemaVersion?: number;
  title?: string;
};

function normalizeText(value: string | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatActionDescription(action: HumanReviewActionRequest) {
  const description = normalizeText(action.description);
  if (description) return description;
  return `Pending action: ${action.name}`;
}

function buildReviewBody(request: HumanReviewRequest) {
  const error = normalizeText(request.error);
  const lines = [
    error ? `Error: ${error}` : null,
    normalizeText(request.prompt),
    ...request.actionRequests.map(formatActionDescription),
  ].filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join('\n\n') : DEFAULT_REVIEW_BODY;
}

function collectAllowedDecisions(request: HumanReviewRequest) {
  const allowed = new Set<HumanReviewDecisionType>();

  for (const decision of DECISION_ORDER) {
    if (request.reviewConfigs.some((config) => config.allowedDecisions.includes(decision))) {
      allowed.add(decision);
    }
  }

  if (allowed.size === 0) {
    allowed.add('approve');
    allowed.add('reject');
    allowed.add('respond');
  }

  return allowed;
}

function optionForDecision(decision: Exclude<HumanReviewDecisionType, 'edit'>): ReviewOption {
  const optionDecision: ReviewOptionDecision = decision === 'respond'
    ? { type: 'respond', messageInputKey: 'message' }
    : { type: decision };

  if (decision === 'approve') {
    return {
      id: 'approve',
      label: 'Approve',
      variant: 'primary',
      decision: optionDecision,
    };
  }
  if (decision === 'reject') {
    return {
      id: 'reject',
      label: 'Reject',
      variant: 'danger',
      decision: optionDecision,
    };
  }
  return {
    id: 'respond',
    label: 'Respond',
    input: {
      kind: 'text',
      key: 'message',
      required: true,
      multiline: true,
    },
    decision: optionDecision,
  };
}

function buildOptionsFromHumanReviewRequest(request: HumanReviewRequest) {
  const allowed = collectAllowedDecisions(request);
  const options: ReviewOption[] = [];

  for (const decision of DECISION_ORDER) {
    if (decision === 'edit' || !allowed.has(decision)) {
      continue;
    }
    options.push(optionForDecision(decision));
  }

  return options.length > 0 ? options : [optionForDecision('reject')];
}

export function buildReviewSpecFromHumanReviewRequest(
  request: HumanReviewRequest,
  options: BuildReviewSpecFromHumanReviewRequestOptions = {},
): ReviewSpec {
  return {
    id: options.id ?? randomUUID(),
    schemaVersion: options.schemaVersion ?? 1,
    view: {
      kind: 'plain',
      ...(options.title ? { title: options.title } : {}),
      body: buildReviewBody(request),
    },
    options: buildOptionsFromHumanReviewRequest(request),
  };
}
