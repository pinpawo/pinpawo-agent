import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import { buildLoadingCellLine } from '../visuals/loadingCells';
import {
  buildApprovalViewModel,
  calculateApprovalDialogLayout,
  type ApprovalState,
} from './approvalModel';
import type { ReviewContentLine, ReviewLineTone } from './reviewContentLines';

const REVIEW_TONE_COLORS: Record<ReviewLineTone, string | undefined> = {
  default: undefined,
  muted: '#8a8a8a',
  heading: '#d6a84b',
  added: '#4fb04f',
  removed: '#d05a5a',
};

export class ApprovalView {
  readonly frame: BoxRenderable;
  readonly input: TextareaRenderable;
  private readonly renderer: CliRenderer;
  private readonly dialog: BoxRenderable;
  private readonly body: BoxRenderable;
  private readonly bodyLines: TextRenderable[] = [];
  private readonly options: TextRenderable;
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
      borderColor: '#d6a84b',
      title: ' Review ',
      titleColor: '#d6a84b',
      bottomTitle: ' ↑↓ option · Enter · Esc cancel ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.body = new BoxRenderable(renderer, {
      id: 'approval-body',
      width: '100%',
      height: 3,
      flexDirection: 'column',
      overflow: 'hidden',
    });
    this.options = new TextRenderable(renderer, {
      id: 'approval-options',
      content: '',
      width: '100%',
      height: 3,
      overflow: 'hidden',
    });
    this.inputFrame = new BoxRenderable(renderer, {
      id: 'approval-input-frame',
      width: '100%',
      height: 0,
      visible: false,
      border: true,
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
    this.dialog.add(this.body);
    this.dialog.add(this.options);
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
    this.dialog.left = layout.left;
    this.dialog.top = layout.top;
    this.dialog.width = layout.width;
    this.dialog.height = layout.height;
    this.dialog.title = model.title;
    this.dialog.bottomTitle = model.bottomTitle;
    this.body.height = model.bodyRows;
    // The submitting state is a single animated status line; every other phase
    // renders the reviewed content with its per-line tones.
    this.renderBodyLines(model.bodyLines, model.loadingFrame);
    this.options.height = model.optionRows;
    this.options.content = model.options;
    this.inputFrame.visible = model.inputVisible;
    this.inputFrame.height = model.inputVisible ? 4 : 0;
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
      // A blank content string collapses the row, so keep a space placeholder.
      renderable.content = line.text || ' ';
      renderable.fg = REVIEW_TONE_COLORS[line.tone] ?? RGBA.defaultForeground();
    });
  }

  focusInput() {
    this.input.focus();
  }
}
