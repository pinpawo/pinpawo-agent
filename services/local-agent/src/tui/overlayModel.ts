import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import type { CommandPaletteModel } from './input/commandPalette';
import type { FileMentionModel } from './input/fileMention';
import type { ApprovalRequestModel } from './state/tuiState';
import type { ResumeSessionSummary, WorkspaceSummary } from './types';

export type TuiOverlayOwner =
  | 'resumePicker'
  | 'workspacePicker'
  | 'approval'
  | 'globalReviewPolicyPicker'
  | 'commandPalette'
  | 'fileMention';

export type TuiOverlayModel = {
  current: TuiOverlay | null;
  owner: TuiOverlayOwner | null;
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
      type: 'workspacePicker';
      label: 'Workspace';
      workspaces: WorkspaceSummary[];
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

export type TuiOverlayModelInput = {
  width: number;
  resumePicker: {
    open: boolean;
    sessions: ResumeSessionSummary[];
    selectedIndex: number;
    loading: boolean;
  };
  workspacePicker?: {
    open: boolean;
    workspaces: WorkspaceSummary[];
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
};

export function buildTuiOverlayModel(input: TuiOverlayModelInput): TuiOverlayModel {
  const current = resolveCurrentOverlay(input);
  return {
    current,
    owner: current?.type ?? null,
    ownerLabel: current?.label ?? null,
    width: input.width,
  };
}

function resolveCurrentOverlay(input: TuiOverlayModelInput): TuiOverlay | null {
  const workspacePicker = input.workspacePicker ?? {
    open: false,
    workspaces: [],
    selectedIndex: 0,
    loading: false,
  };
  if (input.resumePicker.open) {
    return {
      type: 'resumePicker',
      label: 'Resume',
      sessions: input.resumePicker.sessions,
      selectedIndex: input.resumePicker.selectedIndex,
      loading: input.resumePicker.loading,
    };
  }
  if (workspacePicker.open) {
    return {
      type: 'workspacePicker',
      label: 'Workspace',
      workspaces: workspacePicker.workspaces,
      selectedIndex: workspacePicker.selectedIndex,
      loading: workspacePicker.loading,
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
