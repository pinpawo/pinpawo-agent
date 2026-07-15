import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import type { CommandPaletteModel } from './input/commandPalette';
import type { FileMentionModel } from './input/fileMention';
import type { TuiInteractionOwner } from './interactionOwner';
import type { ApprovalRequestModel } from './state/tuiState';
import type { ResumeSessionSummary } from './types';

export type TuiOverlayModel = {
  current: TuiOverlay | null;
  width: number;
};

export type TuiOverlay =
  | {
      type: 'resumePicker';
      label: 'Resume';
      sessions: ResumeSessionSummary[];
      selectedIndex: number;
      loading: boolean;
    }
  | {
      type: 'approval';
      label: 'Approval';
      request: ApprovalRequestModel;
      selectedIndex: number;
    }
  | {
      type: 'globalReviewPolicyPicker';
      label: 'Policy';
      currentMode: BuiltinGlobalReviewPolicyMode;
      selectedIndex: number;
    }
  | {
      type: 'commandPalette';
      label: 'Command';
      model: CommandPaletteModel;
    }
  | {
      type: 'fileMention';
      label: 'File';
      model: FileMentionModel;
    };

export function buildTuiOverlayModel(input: {
  width: number;
  owner: TuiInteractionOwner;
  resumePicker: {
    open: boolean;
    sessions: ResumeSessionSummary[];
    selectedIndex: number;
    loading: boolean;
  };
  approval: {
    request: ApprovalRequestModel | null;
    selectedIndex: number;
  };
  globalReviewPolicyPicker: {
    open: boolean;
    currentMode: BuiltinGlobalReviewPolicyMode;
    selectedIndex: number;
  };
  commandPalette: CommandPaletteModel;
  fileMention: FileMentionModel;
}): TuiOverlayModel {
  const current = resolveCurrentOverlay(input);
  return {
    current,
    width: input.width,
  };
}

function resolveCurrentOverlay(input: Parameters<typeof buildTuiOverlayModel>[0]): TuiOverlay | null {
  switch (input.owner.type) {
    case 'resumePicker':
      return input.resumePicker.open
        ? {
            type: 'resumePicker',
            label: 'Resume',
            sessions: input.resumePicker.sessions,
            selectedIndex: input.resumePicker.selectedIndex,
            loading: input.resumePicker.loading,
          }
        : null;
    case 'approval':
      return input.approval.request
        ? {
            type: 'approval',
            label: 'Approval',
            request: input.approval.request,
            selectedIndex: input.approval.selectedIndex,
          }
        : null;
    case 'globalReviewPolicyPicker':
      return input.globalReviewPolicyPicker.open
        ? {
            type: 'globalReviewPolicyPicker',
            label: 'Policy',
            currentMode: input.globalReviewPolicyPicker.currentMode,
            selectedIndex: input.globalReviewPolicyPicker.selectedIndex,
          }
        : null;
    case 'commandPalette':
      return input.commandPalette.open
        ? {
            type: 'commandPalette',
            label: 'Command',
            model: input.commandPalette,
          }
        : null;
    case 'fileMention':
      return input.fileMention.open
        ? {
            type: 'fileMention',
            label: 'File',
            model: input.fileMention,
          }
        : null;
    default:
      return null;
  }
}
