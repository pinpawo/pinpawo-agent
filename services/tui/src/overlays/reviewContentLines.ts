import type { ReviewView } from '@pinpawo/agent-session';
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
 * Renders one `ReviewView` variant into tone-tagged terminal lines.
 *
 * Every variant declared by the review contract gets a real rendering here:
 * `plain` wraps verbatim, `markdown` gets lightweight structural emphasis, and
 * `diff` is parsed into +/- tinted hunks. Toolkits pick the variant; the TUI
 * never inspects tool names to decide how to display a review.
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
  if (view.kind === 'diff') {
    return renderDiffView(view, width, maxCharacters);
  }
  const header = renderHeader(view.title, width);
  const body = clampCharacters(view.body, maxCharacters);
  const bodyLines = view.kind === 'markdown'
    ? renderMarkdownBody(body, width)
    : wrapTone(body, width, 'default');
  return [...header, ...bodyLines];
}

function renderDiffView(
  view: Extract<ReviewView, { kind: 'diff' }>,
  width: number,
  maxCharacters: number,
): ReviewContentLine[] {
  const meta = [
    ...renderHeader(view.title, width),
    ...(view.summary ? wrapTone(view.summary, width, 'default') : []),
    ...(view.target
      ? [line(truncateTerminalLine(`Target: ${view.target}`, width), 'muted')]
      : []),
  ];
  const patch = clampCharacters(view.patch, maxCharacters);
  const patchLines = renderPatchLines(patch, width);
  return meta.length > 0 && patchLines.length > 0
    ? [...meta, line('', 'default'), ...patchLines]
    : [...meta, ...patchLines];
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

function renderHeader(title: string | undefined, width: number) {
  return title?.trim()
    ? wrapTone(title.trim(), width, 'heading')
    : [];
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
