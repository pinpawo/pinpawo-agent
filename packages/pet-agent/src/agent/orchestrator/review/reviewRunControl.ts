export const TOOLKIT_REVIEW_RUN_CONTROL_STATE_KEY = 'toolkitReviewRunControl' as const;

export const TOOLKIT_REVIEW_RUN_CONTROL = {
  INTERRUPTED: 'interrupted',
} as const;

export type ToolkitReviewRunControl =
  typeof TOOLKIT_REVIEW_RUN_CONTROL[keyof typeof TOOLKIT_REVIEW_RUN_CONTROL];

export function readToolkitReviewRunControl(value: unknown): ToolkitReviewRunControl | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const control = (value as Record<string, unknown>)[TOOLKIT_REVIEW_RUN_CONTROL_STATE_KEY];
  return control === TOOLKIT_REVIEW_RUN_CONTROL.INTERRUPTED ? control : null;
}
