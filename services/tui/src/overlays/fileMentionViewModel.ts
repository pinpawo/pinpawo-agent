import stringWidth from 'string-width';
import type {
  FileMentionItem,
  FileMentionState,
} from '../input/fileMention';
import { truncateTerminalLine } from '../text/terminalText';

export type FileMentionViewModel = {
  title: string;
  bottomTitle: string;
  content: string;
};

export function buildFileMentionViewModel(
  state: Extract<FileMentionState, { phase: 'open' }>,
  width: number,
): FileMentionViewModel {
  const innerWidth = Math.max(1, width - 4);
  return {
    title: ` ${truncateTerminalLine(
      state.query ? `Files · @${state.query}` : 'Files · @',
      innerWidth,
    )} `,
    bottomTitle: ' ↑↓ · Tab/Enter insert · Esc ',
    content: state.items.length
      ? state.items.map((item, index) => formatItem(
          item,
          index === state.selectedIndex,
          innerWidth,
        )).join('\n')
      : truncateTerminalLine('  No matching workspace files', innerWidth),
  };
}

function formatItem(
  item: FileMentionItem,
  selected: boolean,
  width: number,
) {
  const prefix = selected ? '› ' : '  ';
  const kind = item.type === 'directory' ? 'dir' : 'file';
  const suffix = `  ${kind}`;
  const pathWidth = Math.max(
    1,
    width - stringWidth(prefix) - stringWidth(suffix),
  );
  return truncateTerminalLine(
    `${prefix}${truncateTerminalLine(item.path, pathWidth)}${suffix}`,
    width,
  );
}
