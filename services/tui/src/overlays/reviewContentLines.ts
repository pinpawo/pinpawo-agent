import {
  isKnownOperationBlock,
  operationBlockToText,
  type ReceivedOperationBlock,
  type ReviewView,
} from '@pinpawo/agent-session';
import { truncateTerminalLine, wrapTerminalText } from '../text/terminalText';

/**
 * Semantic tone for one rendered review line. The approval view maps these to
 * concrete colors, so the renderer stays independent of the active theme.
 */
export type ReviewLineTone =
  | 'default'
  | 'muted'
  | 'heading'
  | 'added'
  | 'removed';

export type ReviewContentLine = {
  text: string;
  tone: ReviewLineTone;
};

/**
 * Renders the content of one `ReviewView` variant into tone-tagged terminal
 * lines. The view's `title` is not part of the content: the approval dialog
 * shows it as a fixed heading that stays put while the content pages.
 *
 * `plain` wraps verbatim, `markdown` gets lightweight structural emphasis, and
 * `operation` lays out a toolkit's summary block by block. The TUI never
 * inspects tool names to decide how to display a review.
 */
export function buildReviewContentLines(
  view: ReviewView,
  width: number,
  limits: { maxCharacters: number; maxLines: number },
): ReviewContentLine[] {
  const safeWidth = Math.max(1, width);
  const lines = renderView(view, safeWidth, limits.maxCharacters);
  return applyLineLimit(lines, safeWidth, limits.maxLines);
}

function renderView(
  view: ReviewView,
  width: number,
  maxCharacters: number,
): ReviewContentLine[] {
  if (view.kind === 'operation') {
    return renderOperationView(view, width, maxCharacters);
  }
  const body = clampCharacters(view.body, maxCharacters);
  return view.kind === 'markdown'
    ? renderMarkdownBody(body, width)
    : wrapTone(body, width, 'default');
}

/**
 * Lays out a toolkit's operation summary: the summary itself (a shell command,
 * a commit message) reads as the main content, verbatim, with the target in
 * muted text right below it; each block follows after a blank line.
 */
function renderOperationView(
  view: Extract<ReviewView, { kind: 'operation' }>,
  width: number,
  maxCharacters: number,
): ReviewContentLine[] {
  const sections = [
    [
      ...(view.summary ? wrapTone(clampCharacters(view.summary, maxCharacters), width, 'default') : []),
      ...(view.target ? wrapTone(`Target: ${view.target}`, width, 'muted') : []),
    ],
    ...(view.blocks ?? []).map((block) => renderOperationBlock(block, view.target, width, maxCharacters)),
  ].filter((section) => section.length > 0);
  return sections.flatMap((section, index) => (
    index === 0 ? section : [line('', 'default'), ...section]
  ));
}

/**
 * Native rendering for the kinds the TUI knows; any other kind (one from a
 * newer Host) falls back to the shared default text.
 */
function renderOperationBlock(
  block: ReceivedOperationBlock,
  target: string | undefined,
  width: number,
  maxCharacters: number,
): ReviewContentLine[] {
  const fallback = () => wrapTone(clampCharacters(operationBlockToText(block), maxCharacters), width, 'default');
  if (!isKnownOperationBlock(block)) return fallback();
  const text = clampCharacters(block.text, maxCharacters);
  const truncated = block.truncated ? [line('…（内容已截断）', 'muted')] : [];
  switch (block.kind) {
    case 'diff':
      return [
        ...(block.path && block.path !== target ? [line(truncateTerminalLine(block.path, width), 'heading')] : []),
        ...renderPatchLines(text, width),
        ...truncated,
      ];
    case 'code':
      return [...wrapTone(text, width, 'default'), ...truncated];
    case 'text':
      return [
        ...(block.label ? [line(truncateTerminalLine(block.label, width), 'heading')] : []),
        ...wrapTone(text, width, 'default'),
        ...truncated,
      ];
    default:
      return fallback();
  }
}

/**
 * Tints a unified/V4A patch line by line. Parsing deliberately stays textual:
 * a malformed patch still renders as readable text instead of disappearing.
 */
function renderPatchLines(patch: string, width: number): ReviewContentLine[] {
  return patch
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((raw) => {
      const text = raw.replace(/\t/g, '  ');
      if (isPatchEnvelope(text)) return [];
      return [line(truncateTerminalLine(text, width), patchLineTone(text))];
    });
}

function isPatchEnvelope(text: string) {
  const trimmed = text.trim();
  return trimmed === '*** Begin Patch' || trimmed === '*** End Patch';
}

function patchLineTone(text: string): ReviewLineTone {
  if (text.startsWith('+++') || text.startsWith('---')) return 'muted';
  if (text.startsWith('+')) return 'added';
  if (text.startsWith('-')) return 'removed';
  if (text.startsWith('@@') || text.startsWith('***')) return 'heading';
  return 'muted';
}

/**
 * Minimal markdown affordances that survive a terminal: ATX headings become
 * emphasized lines, fenced code keeps its indentation, and list bullets are
 * normalized. Inline spans are intentionally left verbatim.
 */
function renderMarkdownBody(body: string, width: number): ReviewContentLine[] {
  const result: ReviewContentLine[] = [];
  let inFence = false;
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const text = raw.replace(/\t/g, '  ');
    if (/^\s*```/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      result.push(line(truncateTerminalLine(`  ${text}`, width), 'muted'));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      result.push(...wrapTone(heading[2] ?? '', width, 'heading'));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
    if (bullet) {
      result.push(...wrapTone(`${bullet[1] ?? ''}• ${bullet[2] ?? ''}`, width, 'default'));
      continue;
    }
    result.push(...wrapTone(text, width, 'default'));
  }
  return result;
}

function wrapTone(
  value: string,
  width: number,
  tone: ReviewLineTone,
): ReviewContentLine[] {
  if (!value) return [];
  return wrapTerminalText(value, width).map((text) => line(text, tone));
}

function clampCharacters(value: string, maxCharacters: number) {
  return value.length <= maxCharacters ? value : value.slice(0, maxCharacters);
}

function applyLineLimit(
  lines: ReviewContentLine[],
  width: number,
  maxLines: number,
): ReviewContentLine[] {
  if (lines.length === 0) {
    return [line('Review details unavailable.', 'muted')];
  }
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, Math.max(0, maxLines - 1));
  visible.push(line(
    truncateTerminalLine(
      `… ${lines.length - visible.length} more lines`,
      width,
    ),
    'muted',
  ));
  return visible;
}

function line(text: string, tone: ReviewLineTone): ReviewContentLine {
  return { text, tone };
}
