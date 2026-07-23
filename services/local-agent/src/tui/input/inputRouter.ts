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
  | { target: 'timeline'; action: 'page_up' | 'page_down' | 'scroll_up' | 'scroll_down' }
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
      if (isPreviousNavigation(event)) return { target: 'resume', action: 'previous' };
      if (isNextNavigation(event)) return { target: 'resume', action: 'next' };
      if (isReturn) return { target: 'resume', action: 'submit' };
      if (event.type === 'escape') return { target: 'resume', action: 'dismiss' };
      return { target: 'none' };

    case 'globalReviewPolicyPicker':
      if (isPreviousNavigation(event)) return { target: 'globalReviewPolicy', action: 'previous' };
      if (isNextNavigation(event)) return { target: 'globalReviewPolicy', action: 'next' };
      if (isReturn) return { target: 'globalReviewPolicy', action: 'submit' };
      if (event.type === 'escape') return { target: 'globalReviewPolicy', action: 'dismiss' };
      return { target: 'none' };

    case 'approval':
      return routeApprovalInputCommand(event, owner);

    case 'busy':
      if (isTimelineScrollUp(event)) return { target: 'timeline', action: scrollUpAction(event) };
      if (isTimelineScrollDown(event)) return { target: 'timeline', action: scrollDownAction(event) };
      if (event.type === 'escape') return { target: 'global', action: 'interrupt' };
      return { target: 'none' };

    case 'commandPalette':
      if (isPreviousNavigation(event)) return { target: 'commandPalette', action: 'previous' };
      if (isNextNavigation(event)) return { target: 'commandPalette', action: 'next' };
      if (event.type === 'tab') return { target: 'commandPalette', action: 'accept' };
      if (event.type === 'escape') return { target: 'composer', action: 'clear' };
      if (isReturn) return { target: 'commandPalette', action: 'submit' };
      if (isControlSequence) return { target: 'none' };
      if (event.type === 'noop') return { target: 'none' };
      return routeTextAreaCommand(event);

    case 'fileMention':
      if (isPreviousNavigation(event)) return { target: 'fileMention', action: 'previous' };
      if (isNextNavigation(event)) return { target: 'fileMention', action: 'next' };
      if (event.type === 'tab' || isReturn) return { target: 'fileMention', action: 'accept' };
      if (event.type === 'escape') return { target: 'composer', action: 'clear' };
      if (isControlSequence) return { target: 'none' };
      if (event.type === 'noop') return { target: 'none' };
      return routeTextAreaCommand(event);

    case 'composer':
      if (isTimelineScrollUp(event)) return { target: 'timeline', action: scrollUpAction(event) };
      if (isTimelineScrollDown(event)) return { target: 'timeline', action: scrollDownAction(event) };
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
  if (isPreviousNavigation(event)) return 'previous';
  if (isNextNavigation(event)) return 'next';
  return null;
}

function isPreviousNavigation(event: CanonicalInputEvent) {
  return event.type === 'cursor.up'
    || event.type === 'viewport.page.up'
    || event.type === 'viewport.scroll.up';
}

function isNextNavigation(event: CanonicalInputEvent) {
  return event.type === 'cursor.down'
    || event.type === 'viewport.page.down'
    || event.type === 'viewport.scroll.down';
}

function isTimelineScrollUp(event: CanonicalInputEvent) {
  return event.type === 'viewport.page.up' || event.type === 'viewport.scroll.up';
}

function isTimelineScrollDown(event: CanonicalInputEvent) {
  return event.type === 'viewport.page.down' || event.type === 'viewport.scroll.down';
}

function scrollUpAction(
  event: Extract<CanonicalInputEvent, {
    type: 'viewport.page.up' | 'viewport.scroll.up';
  }>,
): 'page_up' | 'scroll_up' {
  return event.type === 'viewport.page.up' ? 'page_up' : 'scroll_up';
}

function scrollDownAction(
  event: Extract<CanonicalInputEvent, {
    type: 'viewport.page.down' | 'viewport.scroll.down';
  }>,
): 'page_down' | 'scroll_down' {
  return event.type === 'viewport.page.down' ? 'page_down' : 'scroll_down';
}
