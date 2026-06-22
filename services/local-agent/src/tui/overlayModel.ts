import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import type { CommandPaletteModel } from './input/commandPalette';
import type { FileMentionModel } from './input/fileMention';
import type { ApprovalRequestModel } from './state/tuiState';
import type { ResumeSessionSummary } from './types';

export type TuiOverlayOwner =
  | 'resumePicker'
  | 'approval'
  | 'globalReviewPolicyPicker'
  | 'commandPalette'
  | 'fileMention';

export type TuiOverlayModel = {
  current: TuiOverlay | null;
  ownerLabel: string | null;
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
    ownerLabel: current?.label ?? null,
    width: input.width,
  };
}

function resolveCurrentOverlay(input: Parameters<typeof buildTuiOverlayModel>[0]): TuiOverlay | null {
  if (input.resumePicker.open) {
    return {
      type: 'resumePicker',
      label: 'Resume',
      sessions: input.resumePicker.sessions,
      selectedIndex: input.resumePicker.selectedIndex,
      loading: input.resumePicker.loading,
    };
  }
  if (input.approval.request) {
    return {
      type: 'approval',
      label: 'Approval',
      request: input.approval.request,
      selectedIndex: input.approval.selectedIndex,
    };
  }
  if (input.globalReviewPolicyPicker.open) {
    return {
      type: 'globalReviewPolicyPicker',
      label: 'Policy',
      currentMode: input.globalReviewPolicyPicker.currentMode,
      selectedIndex: input.globalReviewPolicyPicker.selectedIndex,
    };
  }
  if (input.commandPalette.open) {
    return {
      type: 'commandPalette',
      label: 'Command',
      model: input.commandPalette,
    };
  }
  if (input.fileMention.open) {
    return {
      type: 'fileMention',
      label: 'File',
      model: input.fileMention,
    };
  }
  return null;
}
