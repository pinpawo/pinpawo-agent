import {
  GLOBAL_REVIEW_POLICY_MODE,
  type BuiltinGlobalReviewPolicyMode,
} from '@pinpawo/pet-agent';

export type GlobalReviewPolicyPickerOption = {
  mode: BuiltinGlobalReviewPolicyMode;
  label: string;
  detail: string;
};

export const GLOBAL_REVIEW_POLICY_PICKER_OPTIONS: readonly GlobalReviewPolicyPickerOption[] = [
  {
    mode: GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    label: '需要授权',
    detail: '需要 review 的工具操作都会等待你确认。',
  },
  {
    mode: GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION,
    label: '自动授权',
    detail: '先由 LLM 做安全判断；安全时自动授权，不确定时询问你。',
  },
  {
    mode: GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS,
    label: '完全访问',
    detail: '跳过 review，直接执行工具请求。',
  },
];

export function findGlobalReviewPolicyPickerIndex(mode: BuiltinGlobalReviewPolicyMode) {
  const index = GLOBAL_REVIEW_POLICY_PICKER_OPTIONS.findIndex((option) => option.mode === mode);
  return index >= 0 ? index : 0;
}
