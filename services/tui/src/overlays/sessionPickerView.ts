import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import { buildLoadingCellLine } from '../visuals/loadingCells';
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

  render(state: SessionPickerState, width: number, loadingFrame = 0) {
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
    const loading = state.phase === 'loading' || state.phase === 'resuming';
    const content = formatSessionPicker(
      state,
      loading ? Math.max(1, width - 4) : width,
    );
    this.content.content = loading
      ? buildLoadingCellLine(content, loadingFrame)
      : content;
  }
}
