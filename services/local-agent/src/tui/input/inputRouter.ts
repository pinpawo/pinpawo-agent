import type { CanonicalInputEvent } from './canonicalInput';
import {
  resolveComposerHistoryRoute,
  type ComposerHistoryRouteState,
} from './composerHistoryRouting';
import {
  toTextAreaCommand,
  type TextAreaCommand,
} from './textarea/commands';

export type TuiInputRouteContext = {
  ready: boolean;
  busy: boolean;
  hasPendingApproval: boolean;
  approvalFreeTextActive?: boolean;
  hasResumePicker: boolean;
  hasWorkspacePicker?: boolean;
  hasGlobalReviewPolicyPicker?: boolean;
  hasCommandPalette?: boolean;
  hasFileMention?: boolean;
  hasExternalEditor?: boolean;
  composerHistory?: ComposerHistoryRouteState | null;
};

export type TuiInputRouterState = {
  composerHistory?: ComposerHistoryRouteState | null;
};

export type TuiInputOwner =
  | { type: 'externalEditor' }
  | { type: 'unready' }
  | { type: 'resumePicker' }
  | { type: 'workspacePicker' }
  | { type: 'globalReviewPolicyPicker' }
  | { type: 'approval'; freeTextActive: boolean }
  | { type: 'busy' }
  | { type: 'commandPalette' }
  | { type: 'fileMention' }
  | { type: 'composer' };

export type TuiInputCommand =
  | { target: 'global'; action: 'ctrl_c' | 'interrupt' }
  | { target: 'approval'; action: 'previous' | 'next' | 'submit' }
  | { target: 'resume'; action: 'previous' | 'next' | 'submit' | 'dismiss' }
  | { target: 'workspace'; action: 'previous' | 'next' | 'submit' | 'dismiss' }
  | { target: 'globalReviewPolicy'; action: 'previous' | 'next' | 'submit' | 'dismiss' }
  | { target: 'commandPalette'; action: 'previous' | 'next' | 'accept' | 'submit' }
  | { target: 'fileMention'; action: 'previous' | 'next' | 'accept' }
  | { target: 'composer'; action: 'submit' | 'clear' }
  | { target: 'composerHistory'; action: 'previous' | 'next' }
  | { target: 'textarea'; command: TextAreaCommand }
  | { target: 'none' };

export type TuiLegacyInputCommand =
  | { type: 'global.ctrl_c' }
  | { type: 'global.interrupt' }
  | { type: 'approval.previous' }
  | { type: 'approval.next' }
  | { type: 'approval.submit' }
  | { type: 'resume.previous' }
  | { type: 'resume.next' }
  | { type: 'resume.submit' }
  | { type: 'resume.dismiss' }
  | { type: 'workspace.previous' }
  | { type: 'workspace.next' }
  | { type: 'workspace.submit' }
  | { type: 'workspace.dismiss' }
  | { type: 'globalReviewPolicy.previous' }
  | { type: 'globalReviewPolicy.next' }
  | { type: 'globalReviewPolicy.submit' }
  | { type: 'globalReviewPolicy.dismiss' }
  | { type: 'commandPalette.previous' }
  | { type: 'commandPalette.next' }
  | { type: 'commandPalette.accept' }
  | { type: 'commandPalette.submit' }
  | { type: 'fileMention.previous' }
  | { type: 'fileMention.next' }
  | { type: 'fileMention.accept' }
  | { type: 'composer.submit' }
  | { type: 'composer.clear' }
  | { type: 'composer.history.previous' }
  | { type: 'composer.history.next' }
  | { type: 'composer.edit' }
  | { type: 'none' };

export function resolveTuiInputAction(
  event: CanonicalInputEvent,
  context: TuiInputRouteContext,
): TuiInputCommand {
  const owner = resolveTuiInputOwner(context);
  if (event.type === 'interrupt' && owner.type !== 'externalEditor') {
    return { target: 'global', action: 'ctrl_c' };
  }

  return resolveTuiInputCommand(event, owner, {
    composerHistory: context.composerHistory,
  });
}

export function resolveLegacyTuiInputAction(
  event: CanonicalInputEvent,
  context: TuiInputRouteContext,
): TuiLegacyInputCommand {
  return toLegacyTuiInputCommand(resolveTuiInputAction(event, context));
}

export function resolveTuiInputOwner(context: TuiInputRouteContext): TuiInputOwner {
  if (context.hasExternalEditor) return { type: 'externalEditor' };
  if (!context.ready) return { type: 'unready' };
  if (context.hasResumePicker) return { type: 'resumePicker' };
  if (context.hasWorkspacePicker) return { type: 'workspacePicker' };
  if (context.hasPendingApproval) {
    return { type: 'approval', freeTextActive: Boolean(context.approvalFreeTextActive) };
  }
  if (context.hasGlobalReviewPolicyPicker) return { type: 'globalReviewPolicyPicker' };
  if (context.busy) return { type: 'busy' };
  if (context.hasCommandPalette) return { type: 'commandPalette' };
  if (context.hasFileMention) return { type: 'fileMention' };
  return { type: 'composer' };
}

export function resolveTuiInputCommand(
  event: CanonicalInputEvent,
  owner: TuiInputOwner,
  routerState: TuiInputRouterState = {},
): TuiInputCommand {
  const isReturn = event.type === 'submit';
  const isControlSequence = event.type === 'unknown.control';

  switch (owner.type) {
    case 'externalEditor':
      return { target: 'none' };

    case 'unready':
      return { target: 'none' };

    case 'resumePicker':
      if (event.type === 'cursor.up') return { target: 'resume', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'resume', action: 'next' };
      if (isReturn) return { target: 'resume', action: 'submit' };
      if (event.type === 'escape') return { target: 'resume', action: 'dismiss' };
      return { target: 'none' };

    case 'workspacePicker':
      if (event.type === 'cursor.up') return { target: 'workspace', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'workspace', action: 'next' };
      if (isReturn) return { target: 'workspace', action: 'submit' };
      if (event.type === 'escape') return { target: 'workspace', action: 'dismiss' };
      return { target: 'none' };

    case 'globalReviewPolicyPicker':
      if (event.type === 'cursor.up') return { target: 'globalReviewPolicy', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'globalReviewPolicy', action: 'next' };
      if (isReturn) return { target: 'globalReviewPolicy', action: 'submit' };
      if (event.type === 'escape') return { target: 'globalReviewPolicy', action: 'dismiss' };
      return { target: 'none' };

    case 'approval':
      return routeApprovalInputCommand(event, owner);

    case 'busy':
      if (event.type === 'escape') return { target: 'global', action: 'interrupt' };
      return { target: 'none' };

    case 'commandPalette':
      if (event.type === 'cursor.up') return { target: 'commandPalette', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'commandPalette', action: 'next' };
      if (event.type === 'tab') return { target: 'commandPalette', action: 'accept' };
      if (event.type === 'escape') return { target: 'composer', action: 'clear' };
      if (isReturn) return { target: 'commandPalette', action: 'submit' };
      if (isControlSequence) return { target: 'none' };
      if (event.type === 'noop') return { target: 'none' };
      return routeTextAreaCommand(event);

    case 'fileMention':
      if (event.type === 'cursor.up') return { target: 'fileMention', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'fileMention', action: 'next' };
      if (event.type === 'tab' || isReturn) return { target: 'fileMention', action: 'accept' };
      if (event.type === 'escape') return { target: 'composer', action: 'clear' };
      if (isControlSequence) return { target: 'none' };
      if (event.type === 'noop') return { target: 'none' };
      return routeTextAreaCommand(event);

    case 'composer':
      {
        const historyRoute = resolveComposerHistoryRoute(event, routerState.composerHistory);
        if (historyRoute) return { target: 'composerHistory', action: historyRoute };
      }
      if (event.type === 'escape') return { target: 'composer', action: 'clear' };
      if (isReturn) return { target: 'composer', action: 'submit' };
      if (event.type === 'tab') return { target: 'none' };
      if (isControlSequence) return { target: 'none' };
      if (event.type === 'noop') return { target: 'none' };
      return routeTextAreaCommand(event);
  }
}

export function toLegacyTuiInputCommand(command: TuiInputCommand): TuiLegacyInputCommand {
  switch (command.target) {
    case 'global':
      return { type: `global.${command.action}` };
    case 'approval':
      return { type: `approval.${command.action}` };
    case 'resume':
      return { type: `resume.${command.action}` };
    case 'workspace':
      return { type: `workspace.${command.action}` };
    case 'globalReviewPolicy':
      return { type: `globalReviewPolicy.${command.action}` };
    case 'commandPalette':
      return { type: `commandPalette.${command.action}` };
    case 'fileMention':
      return { type: `fileMention.${command.action}` };
    case 'composer':
      return { type: `composer.${command.action}` };
    case 'composerHistory':
      return { type: `composer.history.${command.action}` };
    case 'textarea':
      return { type: 'composer.edit' };
    case 'none':
      return { type: 'none' };
  }
}

function routeTextAreaCommand(event: CanonicalInputEvent): TuiInputCommand {
  const command = toTextAreaCommand(event);
  return command ? { target: 'textarea', command } : { target: 'none' };
}

function routeApprovalInputCommand(
  event: CanonicalInputEvent,
  owner: Extract<TuiInputOwner, { type: 'approval' }>,
): TuiInputCommand {
  const optionNavigation = resolveApprovalOptionNavigation(event, owner);
  if (optionNavigation) return { target: 'approval', action: optionNavigation };
  if (event.type === 'submit') return { target: 'approval', action: 'submit' };
  if (event.type === 'escape') return { target: 'global', action: 'interrupt' };
  if (event.type === 'tab') return { target: 'none' };
  if (event.type === 'unknown.control') return { target: 'none' };
  if (event.type === 'noop') return { target: 'none' };
  return routeTextAreaCommand(event);
}

function resolveApprovalOptionNavigation(
  event: CanonicalInputEvent,
  owner: Extract<TuiInputOwner, { type: 'approval' }>,
): 'previous' | 'next' | null {
  if (owner.freeTextActive) return null;
  if (event.type === 'cursor.up') return 'previous';
  if (event.type === 'cursor.down') return 'next';
  return null;
}
