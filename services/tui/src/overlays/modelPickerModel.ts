import type {
  AgentInputModality,
  AgentModelProfileSummary,
} from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import { truncateTerminalLine } from '../text/terminalText';
import type { ListModelProfilesResult } from '../session/sessionController';

export type ModelPickerState = {
  phase: 'closed' | 'loading' | 'ready' | 'selecting' | 'error';
  sessionId: string;
  defaultProfileId: string;
  selectedProfileId: string;
  requiredInputModalities: AgentInputModality[];
  profiles: AgentModelProfileSummary[];
  selectedIndex: number;
  message?: string;
};

export type ModelPickerAction =
  | 'move-up'
  | 'move-down'
  | 'select'
  | 'close'
  | null;

export type ModelPickerKey = {
  name: string;
  ctrl: boolean;
};

export function createModelPickerState(): ModelPickerState {
  return {
    phase: 'closed',
    sessionId: '',
    defaultProfileId: '',
    selectedProfileId: '',
    requiredInputModalities: ['text'],
    profiles: [],
    selectedIndex: 0,
  };
}

export function beginModelPickerLoad(
  state: ModelPickerState,
  selectedProfileId = '',
): ModelPickerState {
  return {
    ...state,
    phase: 'loading',
    sessionId: '',
    defaultProfileId: '',
    selectedProfileId,
    requiredInputModalities: ['text'],
    profiles: [],
    selectedIndex: 0,
    message: undefined,
  };
}

export function loadModelPickerProfiles(
  result: ListModelProfilesResult,
): ModelPickerState {
  const selectedIndex = result.profiles.findIndex(
    (profile) => profile.id === result.selectedProfileId,
  );
  return {
    phase: 'ready',
    sessionId: result.sessionId,
    defaultProfileId: result.defaultProfileId,
    selectedProfileId: result.selectedProfileId,
    requiredInputModalities: [...result.requiredInputModalities],
    profiles: result.profiles.map((profile) => ({
      ...profile,
      inputModalities: [...profile.inputModalities],
      issues: [...profile.issues],
    })),
    selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
  };
}

export function closeModelPicker(state: ModelPickerState): ModelPickerState {
  return {
    ...state,
    phase: 'closed',
    message: undefined,
  };
}

export function moveModelPickerSelection(
  state: ModelPickerState,
  delta: number,
): ModelPickerState {
  if (state.phase !== 'ready' && state.phase !== 'error') return state;
  if (state.profiles.length === 0) return state;
  return {
    ...state,
    phase: 'ready',
    selectedIndex: Math.max(
      0,
      Math.min(state.profiles.length - 1, state.selectedIndex + delta),
    ),
    message: undefined,
  };
}

export function selectedModelProfile(state: ModelPickerState) {
  return state.profiles[state.selectedIndex] ?? null;
}

export function canSelectModelProfile(profile: AgentModelProfileSummary) {
  return profile.available && profile.compatible;
}

export function modelProfileIssue(profile: AgentModelProfileSummary) {
  if (canSelectModelProfile(profile)) return null;
  return profile.issues[0]
    ?? (!profile.available
      ? 'profile is unavailable'
      : 'profile is incompatible with this session');
}

export function beginModelSelection(
  state: ModelPickerState,
): ModelPickerState {
  const profile = selectedModelProfile(state);
  if (!profile || state.phase === 'loading' || state.phase === 'selecting') {
    return state;
  }
  const issue = modelProfileIssue(profile);
  return issue
    ? { ...state, phase: 'error', message: issue }
    : { ...state, phase: 'selecting', message: undefined };
}

export function failModelPicker(
  state: ModelPickerState,
  message: string,
): ModelPickerState {
  return {
    ...state,
    phase: 'error',
    message,
  };
}

export function resolveModelPickerKey(
  state: ModelPickerState,
  key: ModelPickerKey,
): ModelPickerAction {
  if (state.phase === 'closed' || (key.ctrl && key.name === 'c')) return null;
  if (state.phase === 'selecting') return null;
  if (key.name === 'escape') return 'close';
  if (key.name === 'up' || key.name === 'k') return 'move-up';
  if (key.name === 'down' || key.name === 'j') return 'move-down';
  if (key.name === 'return') return 'select';
  return null;
}

export function formatModelPicker(
  state: ModelPickerState,
  width: number,
) {
  const innerWidth = Math.max(1, width - 4);
  const maxVisibleProfiles = 4;
  if (state.phase === 'loading') {
    return 'Loading model profiles…';
  }
  if (state.profiles.length === 0) {
    return state.phase === 'error'
      ? truncateTerminalLine(
          `Could not load profiles: ${state.message ?? 'unknown error'}`,
          innerWidth,
        )
      : 'No model profiles are available.';
  }

  const lines = [
    truncateTerminalLine(
      `Session requires: ${state.requiredInputModalities.join(' + ')} · ${
        state.selectedIndex + 1
      }/${state.profiles.length}`,
      innerWidth,
    ),
  ];
  const maxStart = Math.max(0, state.profiles.length - maxVisibleProfiles);
  const start = Math.max(
    0,
    Math.min(maxStart, state.selectedIndex - 1),
  );
  const visibleProfiles = state.profiles.slice(
    start,
    start + maxVisibleProfiles,
  );
  for (const [visibleIndex, profile] of visibleProfiles.entries()) {
    const index = start + visibleIndex;
    const prefix = index === state.selectedIndex ? '› ' : '  ';
    const badges = [
      profile.id === state.selectedProfileId ? 'current' : null,
      profile.id === state.defaultProfileId ? 'default' : null,
      profile.inputModalities.includes('image') ? 'image' : null,
      !profile.available
        ? 'unavailable'
        : !profile.compatible
          ? 'incompatible'
          : null,
    ].filter(Boolean).join(' · ');
    const suffix = badges ? ` · ${badges}` : '';
    const labelBudget = Math.max(
      1,
      innerWidth - stringWidth(prefix) - stringWidth(suffix),
    );
    lines.push(
      `${prefix}${truncateTerminalLine(profile.label, labelBudget)}${suffix}`,
    );
  }
  const selected = selectedModelProfile(state);
  if (selected) {
    const metadata = [
      selected.id,
      selected.provider,
      selected.model,
      selected.endpointHost,
    ].filter(Boolean).join(' · ');
    const detail = selected.issues[0] ?? metadata;
    if (detail) lines.push(truncateTerminalLine(`  ${detail}`, innerWidth));
  }
  if (state.phase === 'selecting') {
    const label = selectedModelProfile(state)?.label ?? 'model';
    lines.push(truncateTerminalLine(`Switching to ${label}…`, innerWidth));
  } else if (state.phase === 'error' && state.message) {
    lines.push(truncateTerminalLine(`Could not switch: ${state.message}`, innerWidth));
  }
  return lines.join('\n');
}
