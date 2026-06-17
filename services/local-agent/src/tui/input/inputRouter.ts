import type { CanonicalInputEvent } from './canonicalInput';

export type TuiInputRouteContext = {
  ready: boolean;
  busy: boolean;
  hasPendingApproval: boolean;
  hasResumePicker: boolean;
};

export type TuiInputOwner =
  | { type: 'unready' }
  | { type: 'resumePicker' }
  | { type: 'approval' }
  | { type: 'busy' }
  | { type: 'composer' };

export type TuiInputCommand =
  | { type: 'global.ctrl_c' }
  | { type: 'global.interrupt' }
  | { type: 'approval.previous' }
  | { type: 'approval.next' }
  | { type: 'approval.submit' }
  | { type: 'resume.previous' }
  | { type: 'resume.next' }
  | { type: 'resume.submit' }
  | { type: 'resume.dismiss' }
  | { type: 'composer.submit' }
  | { type: 'composer.clear' }
  | { type: 'composer.edit' }
  | { type: 'none' };

export function resolveTuiInputAction(
  event: CanonicalInputEvent,
  context: TuiInputRouteContext,
): TuiInputCommand {
  if (event.type === 'interrupt') {
    return { type: 'global.ctrl_c' };
  }

  return resolveTuiInputCommand(event, resolveTuiInputOwner(context));
}

export function resolveTuiInputOwner(context: TuiInputRouteContext): TuiInputOwner {
  if (!context.ready) return { type: 'unready' };
  if (context.hasResumePicker) return { type: 'resumePicker' };
  if (context.hasPendingApproval) return { type: 'approval' };
  if (context.busy) return { type: 'busy' };
  return { type: 'composer' };
}

export function resolveTuiInputCommand(
  event: CanonicalInputEvent,
  owner: TuiInputOwner,
): TuiInputCommand {
  const isReturn = event.type === 'submit';
  const isNewline = event.type === 'newline';
  const isControlSequence = event.type === 'unknown.control';

  switch (owner.type) {
    case 'unready':
      return { type: 'none' };

    case 'resumePicker':
      if (event.type === 'cursor.up') return { type: 'resume.previous' };
      if (event.type === 'cursor.down') return { type: 'resume.next' };
      if (isReturn) return { type: 'resume.submit' };
      if (event.type === 'escape') return { type: 'resume.dismiss' };
      return { type: 'none' };

    case 'approval':
      if (event.type === 'cursor.up') return { type: 'approval.previous' };
      if (event.type === 'cursor.down') return { type: 'approval.next' };
      if (isNewline) return { type: 'composer.edit' };
      if (isReturn) return { type: 'approval.submit' };
      if (event.type === 'escape') return { type: 'global.interrupt' };
      if (event.type === 'tab') return { type: 'none' };
      if (isControlSequence) return { type: 'none' };
      if (event.type === 'noop') return { type: 'none' };
      return { type: 'composer.edit' };

    case 'busy':
      if (event.type === 'escape') return { type: 'global.interrupt' };
      return { type: 'none' };

    case 'composer':
      if (event.type === 'escape') return { type: 'composer.clear' };
      if (isNewline) return { type: 'composer.edit' };
      if (isReturn) return { type: 'composer.submit' };
      if (event.type === 'cursor.up' || event.type === 'cursor.down') return { type: 'composer.edit' };
      if (event.type === 'tab') return { type: 'none' };
      if (isControlSequence) return { type: 'none' };
      if (event.type === 'noop') return { type: 'none' };
      return { type: 'composer.edit' };
  }
}
