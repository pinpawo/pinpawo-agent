import { randomUUID } from 'node:crypto';

export type ReviewView =
  | { kind: 'plain'; title?: string; body: string }
  | { kind: 'markdown'; title?: string; body: string };

export type ReviewOptionInput =
  | {
      kind: 'text';
      key: 'message';
      label?: string;
      placeholder?: string;
      required?: boolean;
      multiline?: boolean;
    };

export type ReviewOptionDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; messageInputKey: 'message' };

export type ReviewActionRef =
  | { type: 'pending_action' };

export type ToolAuthorizationMatcherTemplate =
  | { type: 'policy_hook' }
  | { type: 'shell_pattern'; source: 'args.command' }
  | { type: 'exact_args'; source: 'action.args' };

export type ToolAuthorizationMatcher =
  | { type: 'exact_args'; value: Record<string, unknown> }
  | { type: 'shell_pattern'; value: string };

export type ReviewEffect =
  | {
      type: 'graph.authorize_tool_action';
      scope: 'thread';
      actionRef: ReviewActionRef;
      matcher: ToolAuthorizationMatcherTemplate;
    };

export type ReviewOption = {
  id: string;
  label: string;
  description?: string;
  variant?: 'primary' | 'normal' | 'danger';
  input?: ReviewOptionInput;
  decision: ReviewOptionDecision;
  effects?: ReviewEffect[];
};

export type ReviewSpec = {
  id: string;
  schemaVersion: number;
  view: ReviewView;
  options: ReviewOption[];
};

export type BuildReviewSpecParams = {
  id?: string;
  schemaVersion?: number;
  view: ReviewView;
  options: ReviewOption[];
};

export function buildReviewSpec(params: BuildReviewSpecParams): ReviewSpec {
  return {
    id: params.id ?? randomUUID(),
    schemaVersion: params.schemaVersion ?? 1,
    view: params.view,
    options: params.options,
  };
}

export type PendingReviewAction = {
  actionId: string;
  toolName: string;
  args: Record<string, unknown>;
  description?: string;
};

export type PendingReviewState = {
  requestId: string;
  reviewSpec: ReviewSpec;
  pendingAction: PendingReviewAction;
};

export type HumanReviewInterruptPayload = {
  kind: 'review';
  review: ReviewSpec;
  pendingAction: PendingReviewAction;
  error?: string;
};

export type ReviewResponse = {
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
};

export type ReviewResponseResolution = {
  reviewId: string;
  optionId: string;
  decision:
    | { type: 'approve' }
    | { type: 'reject'; message?: string }
    | { type: 'respond'; message: string };
  effects: ReviewEffect[];
  display: {
    label: string;
    userInputMessage?: string;
  };
};
