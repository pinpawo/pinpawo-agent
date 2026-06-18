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
  hasFileMention?: boolean;
  composerHistory?: ComposerHistoryRouteState | null;
};

export type TuiInputRouterState = {
  composerHistory?: ComposerHistoryRouteState | null;
};

export type TuiInputOwner =
  | { type: 'unready' }
  | { type: 'resumePicker' }
  | { type: 'approval'; freeTextActive: boolean }
  | { type: 'busy' }
  | { type: 'fileMention' }
  | { type: 'composer' };

export type TuiInputCommand =
  | { target: 'global'; action: 'ctrl_c' | 'interrupt' }
  | { target: 'approval'; action: 'previous' | 'next' | 'submit' }
  | { target: 'resume'; action: 'previous' | 'next' | 'submit' | 'dismiss' }
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
  if (event.type === 'interrupt') {
    return { target: 'global', action: 'ctrl_c' };
  }

  return resolveTuiInputCommand(event, resolveTuiInputOwner(context), {
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
  if (!context.ready) return { type: 'unready' };
  if (context.hasResumePicker) return { type: 'resumePicker' };
  if (context.hasPendingApproval) {
    return { type: 'approval', freeTextActive: Boolean(context.approvalFreeTextActive) };
  }
  if (context.busy) return { type: 'busy' };
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
    case 'unready':
      return { target: 'none' };

    case 'resumePicker':
      if (event.type === 'cursor.up') return { target: 'resume', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'resume', action: 'next' };
      if (isReturn) return { target: 'resume', action: 'submit' };
      if (event.type === 'escape') return { target: 'resume', action: 'dismiss' };
      return { target: 'none' };

    case 'approval':
      return routeApprovalInputCommand(event, owner);

    case 'busy':
      if (event.type === 'escape') return { target: 'global', action: 'interrupt' };
      return { target: 'none' };

    case 'fileMention':
      if (event.type === 'cursor.up') return { target: 'fileMention', action: 'previous' };
      if (event.type === 'cursor.down') return { target: 'fileMention', action: 'next' };
      if (event.type === 'tab') return { target: 'fileMention', action: 'accept' };
      if (event.type === 'escape') return { target: 'composer', action: 'clear' };
      if (isReturn) return { target: 'composer', action: 'submit' };
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
