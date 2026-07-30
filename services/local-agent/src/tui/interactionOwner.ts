export type TuiInteractionState = {
  ready: boolean;
  busy: boolean;
  pendingApproval: boolean;
  approvalFreeTextActive?: boolean;
  resumePickerOpen: boolean;
  modelProfilePickerOpen?: boolean;
  globalReviewPolicyPickerOpen?: boolean;
  commandPaletteOpen?: boolean;
  fileMentionOpen?: boolean;
  transcriptViewerOpen?: boolean;
  externalEditorOpen?: boolean;
};

export type TuiInteractionOwner =
  | { type: 'externalEditor' }
  | { type: 'transcriptViewer' }
  | { type: 'unready' }
  | { type: 'resumePicker' }
  | { type: 'approval'; freeTextActive: boolean }
  | { type: 'modelProfilePicker' }
  | { type: 'globalReviewPolicyPicker' }
  | { type: 'busy' }
  | { type: 'commandPalette' }
  | { type: 'fileMention' }
  | { type: 'composer' };

export function resolveTuiInteractionOwner(state: TuiInteractionState): TuiInteractionOwner {
  if (state.externalEditorOpen) return { type: 'externalEditor' };
  if (state.transcriptViewerOpen) return { type: 'transcriptViewer' };
  if (!state.ready) return { type: 'unready' };
  if (state.resumePickerOpen) return { type: 'resumePicker' };
  if (state.pendingApproval) {
    return { type: 'approval', freeTextActive: Boolean(state.approvalFreeTextActive) };
  }
  if (state.modelProfilePickerOpen) return { type: 'modelProfilePicker' };
  if (state.globalReviewPolicyPickerOpen) return { type: 'globalReviewPolicyPicker' };
  if (state.busy) return { type: 'busy' };
  if (state.commandPaletteOpen) return { type: 'commandPalette' };
  if (state.fileMentionOpen) return { type: 'fileMention' };
  return { type: 'composer' };
}
