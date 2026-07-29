export type InteractionOwner =
  | {
      type: 'approval';
      acceptsTextInput: boolean;
    }
  | { type: 'notice' }
  | { type: 'policy-picker' }
  | { type: 'command-help' }
  | { type: 'session-picker' }
  | { type: 'command-palette' }
  | { type: 'file-mention' }
  | { type: 'composer' };

export type InteractionOwnerState = {
  approval: {
    open: boolean;
    acceptsTextInput: boolean;
  };
  noticeOpen: boolean;
  policyPickerOpen: boolean;
  commandHelpOpen: boolean;
  sessionPickerOpen: boolean;
  commandPaletteOpen: boolean;
  fileMentionOpen: boolean;
};

export function resolveInteractionOwner(
  state: InteractionOwnerState,
): InteractionOwner {
  if (state.approval.open) {
    return {
      type: 'approval',
      acceptsTextInput: state.approval.acceptsTextInput,
    };
  }
  if (state.noticeOpen) return { type: 'notice' };
  if (state.policyPickerOpen) return { type: 'policy-picker' };
  if (state.commandHelpOpen) return { type: 'command-help' };
  if (state.sessionPickerOpen) return { type: 'session-picker' };
  if (state.commandPaletteOpen) return { type: 'command-palette' };
  if (state.fileMentionOpen) return { type: 'file-mention' };
  return { type: 'composer' };
}

export function interactionOwnerBlocksPaste(
  owner: InteractionOwner,
) {
  switch (owner.type) {
    case 'approval':
      return !owner.acceptsTextInput;
    case 'notice':
    case 'policy-picker':
    case 'command-help':
    case 'session-picker':
      return true;
    case 'command-palette':
    case 'file-mention':
    case 'composer':
      return false;
  }
}
