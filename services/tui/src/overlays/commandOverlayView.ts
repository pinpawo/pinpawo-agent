import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import {
  buildCommandOverlayViewModel,
  COMMAND_PALETTE_ROWS,
  type CommandOverlayState,
} from './commandOverlayModel';

export class CommandOverlayView {
  readonly frame: BoxRenderable;
  private readonly paletteFrame: BoxRenderable;
  private readonly paletteContent: TextRenderable;
  private readonly helpFrame: BoxRenderable;
  private readonly helpContent: TextRenderable;

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
    });
    this.paletteFrame = new BoxRenderable(renderer, {
      id: 'command-palette',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: COMMAND_PALETTE_ROWS,
      visible: false,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.paletteContent = new TextRenderable(renderer, {
      id: 'command-palette-content',
      width: '100%',
      height: COMMAND_PALETTE_ROWS,
      content: '',
      overflow: 'hidden',
    });
    this.helpFrame = new BoxRenderable(renderer, {
      id: 'command-help',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      visible: false,
      border: true,
      borderColor: '#69c0c8',
      title: ' Help ',
      titleColor: '#69c0c8',
      bottomTitle: ' ↑↓ PgUp/PgDn · Esc/q close ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.helpContent = new TextRenderable(renderer, {
      id: 'command-help-content',
      width: '100%',
      height: '100%',
      content: '',
      overflow: 'hidden',
    });
    this.paletteFrame.add(this.paletteContent);
    this.helpFrame.add(this.helpContent);
    this.frame.add(this.paletteFrame);
    this.frame.add(this.helpFrame);
  }

  render(state: CommandOverlayState, width: number) {
    if (state.phase === 'closed') {
      this.frame.visible = false;
      this.paletteFrame.visible = false;
      this.helpFrame.visible = false;
      return;
    }
    const model = buildCommandOverlayViewModel(state, width);
    this.frame.visible = true;
    if (model.kind === 'palette') {
      this.paletteFrame.visible = true;
      this.helpFrame.visible = false;
      this.paletteContent.content = model.content;
      return;
    }
    this.paletteFrame.visible = false;
    this.helpFrame.visible = true;
    this.helpFrame.title = model.title;
    this.helpFrame.bottomTitle = model.bottomTitle;
    this.helpContent.content = model.content;
  }
}
