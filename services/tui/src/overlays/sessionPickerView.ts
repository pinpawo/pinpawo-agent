import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import {
  formatSessionPicker,
  type SessionPickerState,
} from './sessionPickerModel';

export class SessionPickerView {
  readonly frame: BoxRenderable;
  private readonly content: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.frame = new BoxRenderable(renderer, {
      id: 'session-picker',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 10,
      visible: false,
      border: true,
      title: ' Resume session ',
      titleColor: '#f0a6ca',
      bottomTitle: ' ↑↓ PgUp/PgDn · Enter · Esc ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
    });
    this.content = new TextRenderable(renderer, {
      id: 'session-picker-content',
      content: '',
      width: '100%',
      height: '100%',
    });
    this.frame.add(this.content);
  }

  render(state: SessionPickerState, width: number) {
    const visible = state.phase !== 'closed';
    this.frame.visible = visible;
    if (!visible) return;

    this.frame.title = state.phase === 'resuming'
      ? ' Resume session · working '
      : state.phase === 'error'
        ? ' Resume session · error '
        : ' Resume session ';
    this.frame.bottomTitle = state.phase === 'ready'
      ? ' ↑↓ PgUp/PgDn · Enter · Esc '
      : state.phase === 'resuming'
        ? ' Please wait '
        : ' Esc ';
    this.content.content = formatSessionPicker(state, width);
  }
}
