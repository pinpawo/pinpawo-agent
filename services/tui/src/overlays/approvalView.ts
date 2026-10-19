import {
  bold,
  BoxRenderable,
  fg,
  RGBA,
  StyledText,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core';
import { buildLoadingCellLine } from '../visuals/loadingCells';
import {
  APPROVAL_BODY_GUTTER,
  buildApprovalViewModel,
  calculateApprovalDialogLayout,
  type ApprovalOptionLine,
  type ApprovalState,
} from './approvalModel';
import type { ReviewContentLine, ReviewLineTone } from './reviewContentLines';

const ACCENT_COLOR = '#d6a84b';
const DANGER_COLOR = '#d05a5a';
const MUTED_COLOR = '#8a8a8a';
const GUTTER_COLOR = '#5a5a5a';

const REVIEW_TONE_COLORS: Record<ReviewLineTone, string | undefined> = {
  default: undefined,
  muted: MUTED_COLOR,
  heading: ACCENT_COLOR,
  added: '#4fb04f',
  removed: DANGER_COLOR,
};

const BODY_GUTTER = '│'.padEnd(APPROVAL_BODY_GUTTER, ' ');

export class ApprovalView {
  readonly frame: BoxRenderable;
  readonly input: TextareaRenderable;
  private readonly renderer: CliRenderer;
  private readonly dialog: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly bodyLines: TextRenderable[] = [];
  private readonly gap: BoxRenderable;
  private readonly options: TextRenderable;
  private readonly description: TextRenderable;
  private readonly inputFrame: BoxRenderable;

  constructor(
    renderer: CliRenderer,
    options: {
      onDraftChange: (draft: string) => void;
    },
  ) {
    this.renderer = renderer;
    this.frame = new BoxRenderable(renderer, {
      id: 'approval-overlay',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 20,
      visible: false,
      backgroundColor: RGBA.defaultBackground(),
    });
    this.dialog = new BoxRenderable(renderer, {
      id: 'approval-dialog',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      border: true,
      borderStyle: 'rounded',
      borderColor: ACCENT_COLOR,
      title: ' Review ',
      titleColor: ACCENT_COLOR,
      bottomTitle: ' ↑↓ choose · Enter confirm · Esc cancel ',
      bottomTitleAlignment: 'right',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.heading = new TextRenderable(renderer, {
      id: 'approval-heading',
      content: '',
      width: '100%',
      height: 1,
      overflow: 'hidden',
    });
    this.body = new BoxRenderable(renderer, {
      id: 'approval-body',
      width: '100%',
      height: 3,
      flexDirection: 'column',
      overflow: 'hidden',
    });
    this.gap = new BoxRenderable(renderer, {
      id: 'approval-gap',
      width: '100%',
      height: 0,
    });
    this.options = new TextRenderable(renderer, {
      id: 'approval-options',
      content: '',
      width: '100%',
      height: 3,
      overflow: 'hidden',
    });
    this.description = new TextRenderable(renderer, {
      id: 'approval-description',
      content: '',
      width: '100%',
      height: 0,
      fg: MUTED_COLOR,
      overflow: 'hidden',
    });
    this.inputFrame = new BoxRenderable(renderer, {
      id: 'approval-input-frame',
      width: '100%',
      height: 0,
      visible: false,
      border: true,
      borderStyle: 'rounded',
      borderColor: GUTTER_COLOR,
      paddingLeft: 1,
      paddingRight: 1,
      overflow: 'hidden',
    });
    this.input = new TextareaRenderable(renderer, {
      id: 'approval-input',
      width: '100%',
      height: '100%',
      placeholder: 'Type a response',
      onContentChange: () => options.onDraftChange(this.input.plainText),
    });
    this.inputFrame.add(this.input);
    this.dialog.add(this.heading);
    this.dialog.add(this.body);
    this.dialog.add(this.gap);
    this.dialog.add(this.options);
    this.dialog.add(this.description);
    this.dialog.add(this.inputFrame);
    this.frame.add(this.dialog);
  }

  render(state: ApprovalState, width: number, height: number) {
    if (state.phase === 'closed') {
      this.frame.visible = false;
      this.input.blur();
      return;
    }
    const layout = calculateApprovalDialogLayout(width, height);
    const model = buildApprovalViewModel(state, layout.width, layout.height);
    this.frame.visible = true;
    // A short review gets a short dialog, kept against the bottom of the
    // footer so it sits where the composer was.
    this.dialog.left = layout.left;
    this.dialog.top = layout.top + layout.height - model.dialogRows;
    this.dialog.width = layout.width;
    this.dialog.height = model.dialogRows;
    this.dialog.title = model.title;
    this.dialog.bottomTitle = model.bottomTitle;
    this.heading.visible = model.headingRows > 0;
    this.heading.height = model.headingRows;
    this.heading.content = new StyledText([bold(model.heading ?? '')]);
    this.body.height = model.bodyRows;
    // The submitting state is a single animated status line; every other phase
    // renders the reviewed content with its per-line tones.
    this.renderBodyLines(model.bodyLines, model.loadingFrame);
    this.gap.height = model.gapRows;
    this.options.height = model.optionRows;
    this.options.content = model.optionLines.length
      ? renderOptionLines(model.optionLines)
      : model.options;
    this.description.visible = model.descriptionRows > 0;
    this.description.height = model.descriptionRows;
    this.description.content = model.description
      ? `  ${model.description}`
      : ' ';
    this.inputFrame.visible = model.inputVisible;
    this.inputFrame.height = model.inputRows;
    this.input.placeholder = model.inputPlaceholder;
    if (this.input.plainText !== state.draft) {
      this.input.setText(state.draft);
      this.input.gotoBufferEnd();
    }
    if (!model.inputVisible) this.input.blur();
  }

  /**
   * Renders one TextRenderable per review line so each carries its own tone
   * color. Renderables are pooled and hidden rather than destroyed, keeping
   * paging through a long diff free of per-frame allocation.
   */
  private renderBodyLines(
    lines: readonly ReviewContentLine[],
    loadingFrame: number | null,
  ) {
    while (this.bodyLines.length < lines.length) {
      const text = new TextRenderable(this.renderer, {
        id: `approval-body-line-${this.bodyLines.length}`,
        content: '',
        width: '100%',
        height: 1,
        overflow: 'hidden',
      });
      this.bodyLines.push(text);
      this.body.add(text);
    }
    this.bodyLines.forEach((renderable, index) => {
      const line = lines[index];
      renderable.visible = line !== undefined;
      if (!line) return;
      if (loadingFrame !== null && index === 0) {
        renderable.content = buildLoadingCellLine(line.text, loadingFrame);
        return;
      }
      // The gutter marks the reviewed content as quoted material, apart from
      // the dialog's own heading and decisions.
      const color = REVIEW_TONE_COLORS[line.tone];
      renderable.content = new StyledText([
        fg(GUTTER_COLOR)(BODY_GUTTER),
        color ? fg(color)(line.text) : plain(line.text),
      ]);
    });
  }

  focusInput() {
    this.input.focus();
  }
}

/**
 * The selected decision carries the accent (or the danger color for a
 * destructive one); the rest stay in the terminal's own foreground so the
 * list reads quietly until the operator moves through it.
 */
function renderOptionLines(lines: readonly ApprovalOptionLine[]) {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(plain('\n'));
    const color = line.variant === 'danger' ? DANGER_COLOR : ACCENT_COLOR;
    if (line.selected) {
      chunks.push(fg(color)('❯ '), bold(fg(color)(line.text)));
      return;
    }
    chunks.push(
      plain('  '),
      line.variant === 'danger' ? fg(DANGER_COLOR)(line.text) : plain(line.text),
    );
  });
  return new StyledText(chunks);
}

function plain(text: string): TextChunk {
  return fg(RGBA.defaultForeground())(text);
}
