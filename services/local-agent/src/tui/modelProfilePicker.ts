import type { AgentModelProfileSummary } from '@pinpawo/agent-session';
import type { TuiModelProfileList } from './TuiRuntimeController';

export type ModelProfilePickerState = TuiModelProfileList & {
  selectedIndex: number;
  loading: boolean;
};

export const MODEL_PROFILE_PICKER_VISIBLE_LIMIT = 4;

export function createLoadingModelProfilePicker(
  currentProfileId?: string,
): ModelProfilePickerState {
  return {
    sessionId: '',
    defaultProfileId: '',
    selectedProfileId: currentProfileId ?? '',
    requiredInputModalities: ['text'],
    profiles: [],
    selectedIndex: 0,
    loading: true,
  };
}

export function createLoadedModelProfilePicker(
  result: TuiModelProfileList,
  preferredProfileId?: string,
): ModelProfilePickerState {
  const selectedIndex = findModelProfilePickerIndex(
    result.profiles,
    preferredProfileId ?? result.selectedProfileId,
  );
  return {
    ...result,
    requiredInputModalities: [...result.requiredInputModalities],
    profiles: result.profiles.map((profile) => ({
      ...profile,
      inputModalities: [...profile.inputModalities],
      issues: [...profile.issues],
    })),
    selectedIndex,
    loading: false,
  };
}

export function findModelProfilePickerIndex(
  profiles: readonly AgentModelProfileSummary[],
  profileId: string,
) {
  const index = profiles.findIndex((profile) => profile.id === profileId);
  return index >= 0 ? index : 0;
}

export function moveModelProfilePickerSelection(
  state: Pick<ModelProfilePickerState, 'profiles' | 'selectedIndex'>,
  delta: -1 | 1,
) {
  if (state.profiles.length === 0) return 0;
  return Math.max(
    0,
    Math.min(state.profiles.length - 1, state.selectedIndex + delta),
  );
}

export function windowModelProfilePickerProfiles(
  profiles: readonly AgentModelProfileSummary[],
  selectedIndex: number,
  limit = MODEL_PROFILE_PICKER_VISIBLE_LIMIT,
) {
  if (profiles.length === 0 || limit <= 0) {
    return {
      start: 0,
      profiles: [] as AgentModelProfileSummary[],
    };
  }
  const boundedIndex = Math.max(
    0,
    Math.min(profiles.length - 1, selectedIndex),
  );
  const maxStart = Math.max(0, profiles.length - limit);
  const start = Math.max(
    0,
    Math.min(maxStart, boundedIndex - 1),
  );
  return {
    start,
    profiles: profiles.slice(start, start + limit),
  };
}

export function canSelectModelProfile(profile: AgentModelProfileSummary) {
  return profile.available && profile.compatible;
}

export function readModelProfileSelectionIssue(
  profile: AgentModelProfileSummary,
) {
  if (canSelectModelProfile(profile)) return null;
  return profile.issues[0]
    ?? (!profile.available
      ? '该模型配置当前不可用。'
      : '该模型不兼容当前会话已使用的输入类型。');
}
