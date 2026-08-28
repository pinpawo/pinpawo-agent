import type { AgentPlan, AgentPlanItem } from '@pinpawo/agent-session';
import stringWidth from 'string-width';
import { truncateTerminalLine, wrapTerminalText } from '../text/terminalText';

const MIN_VISIBLE_ITEMS = 4;

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

  // Between delegations no item is active; the next pending step still tells
  // the operator where the plan stands.
  const active = plan.items.find((item) => item.status === 'active')
    ?? plan.items.find((item) => item.status === 'pending')
    ?? plan.items.at(-1);
  if (!active) return { content: '', height: 0, mode: 'hidden' };
  const currentStep = plan.items.indexOf(active) + 1;

  if (options.overlayOpen) {
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
    MIN_VISIBLE_ITEMS,
    Math.min(plan.items.length, Math.floor(options.terminalHeight / 4)),
  );
  const visibleItems = selectVisibleItems(plan.items, maxVisible, currentStep - 1);
  const omitted = plan.items.length - visibleItems.length;
  const lines = [
    ...wrapTerminalText(`当前计划 · ${currentStep}/${plan.items.length}`, options.width),
    ...visibleItems.flatMap((item) => formatItemLines(item, options.width)),
    ...(omitted > 0
      ? wrapTerminalText(`  … 还有 ${omitted} 项`, options.width)
      : []),
  ];
  return {
    content: lines.join('\n'),
    height: lines.length,
    mode: 'expanded',
  };
}

function selectVisibleItems(
  items: AgentPlanItem[],
  maxVisible: number,
  focusIndex: number,
) {
  if (items.length <= maxVisible) return items;
  const start = Math.max(0, Math.min(focusIndex - 1, items.length - maxVisible));
  return items.slice(start, start + maxVisible);
}

function formatItemLines(item: AgentPlanItem, width: number) {
  const contentWidth = Math.max(1, width);
  const prefix = `  ${formatItemPrefix(item)}`;
  const prefixWidth = stringWidth(prefix);
  if (prefixWidth < contentWidth) {
    const taskLines = wrapTerminalText(item.task, contentWidth - prefixWidth);
    const continuationPrefix = ' '.repeat(prefixWidth);
    return taskLines.map((line, index) => (
      `${index === 0 ? prefix : continuationPrefix}${line}`
    ));
  }

  const continuationWidth = Math.min(4, Math.max(0, contentWidth - 1));
  const continuationPrefix = ' '.repeat(continuationWidth);
  return [
    ...wrapTerminalText(prefix.trimEnd(), contentWidth),
    ...wrapTerminalText(item.task, contentWidth - continuationWidth)
      .map((line) => `${continuationPrefix}${line}`),
  ];
}

function formatItem(item: AgentPlanItem) {
  return `${formatItemPrefix(item)}${item.task}`;
}

function formatItemPrefix(item: AgentPlanItem) {
  const marker = item.status === 'completed'
    ? '✓'
    : item.status === 'active'
      ? '→'
      : '·';
  return `${marker} ${item.capability} · `;
}
