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
  // Between delegations no item is active; the next pending step still tells
  // the operator where the plan stands.
  const active = plan.items.find((item) => item.status === 'active')
    ?? plan.items.find((item) => item.status === 'pending')
    ?? plan.items.at(-1);
  if (!active) return { content: '', height: 0, mode: 'hidden' };
  const currentStep = plan.items.indexOf(active) + 1;

  if (compact) {
    return {
      content: truncateTerminalLine(
        `计划 ${currentStep}/${plan.items.length} · ${formatItem(active)}`,
        options.width,
      ),
      height: 1,
      mode: 'compact',
    };
  }

  // A taller terminal can show more of the plan; the cap only exists to keep
  // the panel from crowding out the transcript.
  const maxVisible = Math.max(
    MAX_VISIBLE_ITEMS,
    Math.min(plan.items.length, Math.floor(options.terminalHeight / 4)),
  );
  const visibleItems = selectVisibleItems(plan.items, maxVisible);
  const omitted = plan.items.length - visibleItems.length;
  const lines = [
    `当前计划 · ${currentStep}/${plan.items.length}`,
    ...visibleItems.map((item) => `  ${formatItem(item)}`),
    ...(omitted > 0 ? [`  … 还有 ${omitted} 项`] : []),
  ].map((line) => truncateTerminalLine(line, options.width));
  return {
    content: lines.join('\n'),
    height: lines.length,
    mode: 'expanded',
  };
}

function selectVisibleItems(items: AgentPlanItem[], maxVisible: number) {
  if (items.length <= maxVisible) return items;
  const activeIndex = Math.max(0, items.findIndex((item) => item.status === 'active'));
  const start = Math.max(0, Math.min(activeIndex - 1, items.length - maxVisible));
  return items.slice(start, start + maxVisible);
}

function formatItem(item: AgentPlanItem) {
  const marker = item.status === 'completed'
    ? '✓'
    : item.status === 'active'
      ? '→'
      : '·';
  return `${marker} ${item.capability} · ${item.task}`;
}
