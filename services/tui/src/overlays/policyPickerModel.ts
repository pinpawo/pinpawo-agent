import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import { truncateTerminalLine } from '../text/terminalText';

export type PolicyPickerOption = {
  mode: BuiltinGlobalReviewPolicyMode;
  label: string;
  detail: string;
};

export const POLICY_PICKER_OPTIONS: readonly PolicyPickerOption[] = [{
  mode: 'require_authorization',
  label: 'Ask every time',
  detail: 'Every reviewed tool action waits for your decision.',
}, {
  mode: 'auto_authorization',
  label: 'Auto authorize',
  detail: 'The model may authorize safe actions; uncertain actions still ask.',
}, {
  mode: 'full_access',
  label: 'Full access',
  detail: 'Reviewed tool actions run without waiting for approval.',
}];

export type PolicyPickerState = {
  phase: 'closed' | 'ready' | 'saving' | 'error';
  currentMode: BuiltinGlobalReviewPolicyMode;
  selectedIndex: number;
  message?: string;
};

export type PolicyPickerAction =
  | 'move-up'
  | 'move-down'
  | 'select'
  | 'close'
  | null;

export type PolicyPickerKey = {
  name: string;
  ctrl: boolean;
};

export function createPolicyPickerState(
  currentMode: BuiltinGlobalReviewPolicyMode = 'require_authorization',
): PolicyPickerState {
  return {
    phase: 'closed',
    currentMode,
    selectedIndex: optionIndex(currentMode),
  };
}

export function openPolicyPicker(
  state: PolicyPickerState,
  currentMode: BuiltinGlobalReviewPolicyMode,
): PolicyPickerState {
  return {
    ...state,
    phase: 'ready',
    currentMode,
    selectedIndex: optionIndex(currentMode),
    message: undefined,
  };
}

export function closePolicyPicker(
  state: PolicyPickerState,
): PolicyPickerState {
  return {
    ...state,
    phase: 'closed',
    message: undefined,
  };
}

export function movePolicySelection(
  state: PolicyPickerState,
  delta: number,
): PolicyPickerState {
  if (state.phase !== 'ready' && state.phase !== 'error') return state;
  return {
    ...state,
    phase: 'ready',
    selectedIndex: Math.max(
      0,
      Math.min(POLICY_PICKER_OPTIONS.length - 1, state.selectedIndex + delta),
    ),
    message: undefined,
  };
}

export function beginPolicySave(state: PolicyPickerState): PolicyPickerState {
  return state.phase === 'ready' || state.phase === 'error'
    ? { ...state, phase: 'saving', message: undefined }
    : state;
}

export function failPolicySave(
  state: PolicyPickerState,
  message: string,
): PolicyPickerState {
  return {
    ...state,
    phase: 'error',
    message,
  };
}

export function selectedPolicy(
  state: PolicyPickerState,
): PolicyPickerOption | null {
  return POLICY_PICKER_OPTIONS[state.selectedIndex] ?? null;
}

export function resolvePolicyPickerKey(
  state: PolicyPickerState,
  key: PolicyPickerKey,
): PolicyPickerAction {
  if (state.phase === 'closed' || (key.ctrl && key.name === 'c')) return null;
  if (key.name === 'escape') return 'close';
  if (state.phase === 'saving') return null;
  if (key.name === 'up' || key.name === 'k') return 'move-up';
  if (key.name === 'down' || key.name === 'j') return 'move-down';
  if (key.name === 'return') return 'select';
  return null;
}

export function formatPolicyPicker(
  state: PolicyPickerState,
  width: number,
) {
  const innerWidth = Math.max(1, width - 4);
  if (state.phase === 'saving') {
    const label = selectedPolicy(state)?.label ?? 'policy';
    return truncateTerminalLine(`Saving ${label}…`, innerWidth);
  }

  const lines = POLICY_PICKER_OPTIONS.map((option, index) => {
    const prefix = index === state.selectedIndex ? '› ' : '  ';
    const current = option.mode === state.currentMode ? ' · current' : '';
    const labelBudget = Math.max(
      1,
      innerWidth - stringWidth(prefix) - stringWidth(current),
    );
    return `${prefix}${truncateTerminalLine(option.label, labelBudget)}${current}`;
  });
  const selected = selectedPolicy(state);
  if (selected) {
    lines.push(truncateTerminalLine(selected.detail, innerWidth));
  }
  if (state.phase === 'error') {
    lines.push(truncateTerminalLine(
      `Could not save: ${state.message ?? 'unknown error'}`,
      innerWidth,
    ));
  }
  return lines.join('\n');
}

export function formatPolicyMode(mode: BuiltinGlobalReviewPolicyMode) {
  switch (mode) {
    case 'require_authorization':
      return 'ask';
    case 'auto_authorization':
      return 'auto';
    case 'full_access':
      return 'full';
  }
}

function optionIndex(mode: BuiltinGlobalReviewPolicyMode) {
  const index = POLICY_PICKER_OPTIONS.findIndex((option) => option.mode === mode);
  return index >= 0 ? index : 0;
}
