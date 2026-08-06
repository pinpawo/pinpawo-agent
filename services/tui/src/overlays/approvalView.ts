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

export class ApprovalView {
  readonly frame: BoxRenderable;
  readonly input: TextareaRenderable;
  private readonly dialog: BoxRenderable;
  private readonly body: TextRenderable;
  private readonly options: TextRenderable;
  private readonly inputFrame: BoxRenderable;

  constructor(
    renderer: CliRenderer,
    options: {
      onDraftChange: (draft: string) => void;
    },
  ) {
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
    this.body = new TextRenderable(renderer, {
      id: 'approval-body',
      content: '',
      width: '100%',
      height: 3,
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
    this.body.content = model.loadingFrame === null
      ? model.body
      : buildLoadingCellLine(model.body, model.loadingFrame);
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

  focusInput() {
    this.input.focus();
  }
}
