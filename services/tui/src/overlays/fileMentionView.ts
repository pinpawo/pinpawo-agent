import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import type { FileMentionState } from '../input/fileMention';
import { buildFileMentionViewModel } from './fileMentionViewModel';

export class FileMentionView {
  readonly frame: BoxRenderable;
  private readonly content: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.frame = new BoxRenderable(renderer, {
      id: 'file-mention-overlay',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 6,
      visible: false,
      border: true,
      borderColor: '#69c0c8',
      title: ' Files · @ ',
      titleColor: '#69c0c8',
      bottomTitle: ' ↑↓ · Tab/Enter insert · Esc ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.content = new TextRenderable(renderer, {
      id: 'file-mention-overlay-content',
      width: '100%',
      height: '100%',
      content: '',
      overflow: 'hidden',
    });
    this.frame.add(this.content);
  }

  render(state: FileMentionState, width: number) {
    if (state.phase === 'closed') {
      this.frame.visible = false;
      return;
    }
    const model = buildFileMentionViewModel(state, width);
    this.frame.visible = true;
    this.frame.title = model.title;
    this.frame.bottomTitle = model.bottomTitle;
    this.content.content = model.content;
  }
}
