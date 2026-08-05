import type { AgentPlan, AgentPlanItem } from '@pinpawo/agent-session';
import { truncateTerminalLine } from '../text/terminalText';

const EXPANDED_MIN_TERMINAL_ROWS = 24;
const EXPANDED_MIN_WIDTH = 56;
const MAX_VISIBLE_ITEMS = 4;

export type CurrentPlanPanel = {
  content: string;
  height: number;
  mode: 'hidden' | 'compact' | 'expanded';
};

export function buildCurrentPlanPanel(
  plan: AgentPlan | null | undefined,
  options: {
    width: number;
    terminalHeight: number;
    overlayOpen?: boolean;
  },
): CurrentPlanPanel {
  if (!plan?.items.length) return { content: '', height: 0, mode: 'hidden' };

  const compact = options.overlayOpen
    || options.terminalHeight < EXPANDED_MIN_TERMINAL_ROWS
    || options.width < EXPANDED_MIN_WIDTH;
  const completed = plan.items.filter((item) => item.status === 'completed').length;
  const active = plan.items.find((item) => item.status === 'active')
    ?? plan.items.find((item) => item.status === 'pending')
    ?? plan.items.at(-1);
  if (!active) return { content: '', height: 0, mode: 'hidden' };

  if (compact) {
    return {
      content: truncateTerminalLine(
        `计划 ${completed}/${plan.items.length} · ${formatItem(active)}`,
        options.width,
      ),
      height: 1,
      mode: 'compact',
    };
  }

  const visibleItems = selectVisibleItems(plan.items);
  const omitted = plan.items.length - visibleItems.length;
  const lines = [
    `当前计划 · ${completed}/${plan.items.length}`,
    ...visibleItems.map((item) => `  ${formatItem(item)}`),
    ...(omitted > 0 ? [`  … 还有 ${omitted} 项`] : []),
  ].map((line) => truncateTerminalLine(line, options.width));
  return {
    content: lines.join('\n'),
    height: lines.length,
    mode: 'expanded',
  };
}

function selectVisibleItems(items: AgentPlanItem[]) {
  if (items.length <= MAX_VISIBLE_ITEMS) return items;
  const activeIndex = Math.max(0, items.findIndex((item) => item.status === 'active'));
  const start = Math.max(0, Math.min(activeIndex - 1, items.length - MAX_VISIBLE_ITEMS));
  return items.slice(start, start + MAX_VISIBLE_ITEMS);
}

function formatItem(item: AgentPlanItem) {
  const marker = item.status === 'completed'
    ? '✓'
    : item.status === 'active'
      ? '→'
      : '·';
  return `${marker} ${item.capability} · ${item.task}`;
}
