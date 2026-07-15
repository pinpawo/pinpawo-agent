import type { CanonicalInputEvent } from './canonicalInput';
import {
  resolveComposerHistoryRoute,
  type ComposerHistoryRouteState,
} from './composerHistoryRouting';
import {
  toTextAreaCommand,
  type TextAreaCommand,
} from './textarea/commands';
import type { TuiInteractionOwner } from '../interactionOwner';

export type TuiInputRouterState = {
  composerHistory?: ComposerHistoryRouteState | null;
};

export type TuiInputCommand =
  | { target: 'global'; action: 'ctrl_c' | 'interrupt' }
  | { target: 'approval'; action: 'previous' | 'next' | 'submit' }
  | { target: 'resume'; action: 'previous' | 'next' | 'submit' | 'dismiss' }
  | { target: 'globalReviewPolicy'; action: 'previous' | 'next' | 'submit' | 'dismiss' }
  | { target: 'commandPalette'; action: 'previous' | 'next' | 'accept' | 'submit' }
  | { target: 'fileMention'; action: 'previous' | 'next' | 'accept' }
  | { target: 'composer'; action: 'submit' | 'clear' }
  | { target: 'composerHistory'; action: 'previous' | 'next' }
  | { target: 'textarea'; command: TextAreaCommand }
  | { target: 'none' };

export function resolveTuiInputAction(
  event: CanonicalInputEvent,
  owner: TuiInteractionOwner,
  routerState: TuiInputRouterState = {},
): TuiInputCommand {
  if (event.type === 'interrupt' && owner.type !== 'externalEditor') {
    return { target: 'global', action: 'ctrl_c' };
  }

  return resolveTuiInputCommand(event, owner, routerState);
}

export function resolveTuiInputCommand(
  event: CanonicalInputEvent,
  owner: TuiInteractionOwner,
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

function routeTextAreaCommand(event: CanonicalInputEvent): TuiInputCommand {
  const command = toTextAreaCommand(event);
  return command ? { target: 'textarea', command } : { target: 'none' };
}

function routeApprovalInputCommand(
  event: CanonicalInputEvent,
  owner: Extract<TuiInteractionOwner, { type: 'approval' }>,
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
  owner: Extract<TuiInteractionOwner, { type: 'approval' }>,
): 'previous' | 'next' | null {
  if (owner.freeTextActive) return null;
  if (event.type === 'cursor.up') return 'previous';
  if (event.type === 'cursor.down') return 'next';
  return null;
}
