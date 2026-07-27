import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import {
  buildCommandOverlayViewModel,
  type CommandOverlayState,
} from './commandOverlayModel';

export class CommandOverlayView {
  readonly frame: BoxRenderable;
  private readonly content: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.frame = new BoxRenderable(renderer, {
      id: 'command-overlay',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 5,
      visible: false,
      border: true,
      borderColor: '#69c0c8',
      title: ' Commands ',
      titleColor: '#69c0c8',
      bottomTitle: ' ↑↓ · Enter · Esc ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.content = new TextRenderable(renderer, {
      id: 'command-overlay-content',
      width: '100%',
      height: '100%',
      content: '',
      overflow: 'hidden',
    });
    this.frame.add(this.content);
  }

  render(state: CommandOverlayState, width: number) {
    if (state.phase === 'closed') {
      this.frame.visible = false;
      return;
    }
    const model = buildCommandOverlayViewModel(state, width);
    this.frame.visible = true;
    this.frame.title = model.title;
    this.frame.bottomTitle = model.bottomTitle;
    this.content.content = model.content;
  }
}
