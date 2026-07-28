import {
  SyntaxStyle,
  type TextareaRenderable,
} from '@opentui/core';
import {
  buildComposerDecorations,
  type ComposerDecorationTone,
} from './composerDecorationModel';
import { composerPositionAtTextOffset } from './composerTextPosition';
import type { FileMentionCompletion } from './fileMention';

const FILE_MENTION_EXTMARK = 'pinpawo:file-mention';

type CompletedFileMentionData = {
  path: string;
};

export function createComposerDecorationStyle() {
  return SyntaxStyle.fromStyles({
    code: { fg: '#69c0c8' },
    command: { fg: '#f0a6ca', bold: true },
    heading: { fg: '#5fd75f', bold: true },
    link: { fg: '#69c0c8', underline: true },
    marker: { fg: '#d7af5f', bold: true },
    mention: { fg: '#69c0c8', underline: true },
    quote: { fg: '#a8a8a8', italic: true },
    strong: { bold: true },
  });
}

export function refreshComposerDecorations(
  textarea: TextareaRenderable,
  style: SyntaxStyle,
  fileMentionTypeId?: number,
) {
  const fileMentions = fileMentionTypeId === undefined
    ? []
    : validFileMentionExtmarks(textarea, fileMentionTypeId);
  textarea.clearAllHighlights();
  for (const decoration of buildComposerDecorations(textarea.plainText)) {
    const styleId = styleIdForTone(style, decoration.tone);
    if (styleId === null) continue;
    textarea.addHighlight(decoration.line, {
      start: decoration.start,
      end: decoration.end,
      styleId,
      priority: decoration.priority,
    });
  }
  const mentionStyleId = styleIdForTone(style, 'mention');
  if (mentionStyleId === null) return;
  for (const mention of fileMentions) {
    const start = textarea.editBuffer.offsetToPosition(mention.start);
    const end = textarea.editBuffer.offsetToPosition(mention.end);
    if (!start || !end || start.row !== end.row) continue;
    textarea.addHighlight(start.row, {
      start: start.col,
      end: end.col,
      styleId: mentionStyleId,
      priority: 50,
    });
  }
}

export class ComposerDecorationController {
  private readonly fileMentionTypeId: number;
  private refreshScheduled = false;
  private destroyed = false;

  constructor(
    private readonly textarea: TextareaRenderable,
    private readonly style: SyntaxStyle,
  ) {
    this.fileMentionTypeId =
      textarea.extmarks.registerType(FILE_MENTION_EXTMARK);
  }

  scheduleRefresh() {
    if (this.refreshScheduled || this.destroyed) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.destroyed || this.textarea.isDestroyed) return;
      refreshComposerDecorations(
        this.textarea,
        this.style,
        this.fileMentionTypeId,
      );
    });
  }

  addCompletedFileMention(completion: FileMentionCompletion) {
    if (this.destroyed) return;
    const start = composerPositionAtTextOffset(
      completion.text,
      completion.mention.start,
    );
    const end = composerPositionAtTextOffset(
      completion.text,
      completion.mention.end,
    );
    this.textarea.extmarks.create({
      start: this.textarea.editBuffer.positionToOffset(
        start.row,
        start.column,
      ),
      end: this.textarea.editBuffer.positionToOffset(
        end.row,
        end.column,
      ),
      typeId: this.fileMentionTypeId,
      data: {
        path: completion.mention.path,
      } satisfies CompletedFileMentionData,
    });
    this.scheduleRefresh();
  }

  get completedFileMentions() {
    return validFileMentionExtmarks(
      this.textarea,
      this.fileMentionTypeId,
    );
  }

  destroy() {
    this.destroyed = true;
  }
}

function styleIdForTone(
  style: SyntaxStyle,
  tone: ComposerDecorationTone,
) {
  return style.getStyleId(tone);
}

function validFileMentionExtmarks(
  textarea: TextareaRenderable,
  typeId: number,
) {
  // OpenTUI 0.4.5 restores the extmark map on undo, but not its per-type
  // index after a mark was fully deleted. The canonical map remains correct,
  // so filter it directly until the upstream simulated extmarks are replaced.
  return textarea.extmarks.getAll().filter((extmark) => {
    if (extmark.typeId !== typeId) return false;
    const data = completedFileMentionData(extmark.data);
    if (!data) return false;
    const text = textarea.getTextRange(extmark.start, extmark.end);
    return text === `@${data.path}`;
  });
}

function completedFileMentionData(
  value: unknown,
): CompletedFileMentionData | null {
  if (
    typeof value !== 'object'
    || value === null
    || !('path' in value)
    || typeof value.path !== 'string'
  ) {
    return null;
  }
  return {
    path: value.path,
  };
}
