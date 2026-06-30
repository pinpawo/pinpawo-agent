export const TUI_TIMELINE_VIEW_MODES = ['snapshot', 'process'] as const;

export type TuiTimelineViewMode = (typeof TUI_TIMELINE_VIEW_MODES)[number];

export function parseTuiTimelineViewMode(input: string): TuiTimelineViewMode | null {
  const value = input.trim().toLowerCase();
  if (value === 'snapshot' || value === 'main' || value === 'chat') return 'snapshot';
  if (value === 'process' || value === 'operations' || value === 'operation' || value === 'ops') {
    return 'process';
  }
  return null;
}

export function formatTuiTimelineViewMode(mode: TuiTimelineViewMode) {
  return mode === 'snapshot' ? '对话' : '过程';
}
