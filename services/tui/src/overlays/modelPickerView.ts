import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import {
  formatModelPicker,
  type ModelPickerState,
} from './modelPickerModel';

export class ModelPickerView {
  readonly frame: BoxRenderable;
  private readonly content: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.frame = new BoxRenderable(renderer, {
      id: 'model-picker',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 10,
      visible: false,
      border: true,
      title: ' Session model ',
      titleColor: '#f0a6ca',
      bottomTitle: ' ↑↓ · Enter switch · Esc ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
    });
    this.content = new TextRenderable(renderer, {
      id: 'model-picker-content',
      content: '',
      width: '100%',
      height: '100%',
    });
    this.frame.add(this.content);
  }

  render(state: ModelPickerState, width: number) {
    const visible = state.phase !== 'closed';
    this.frame.visible = visible;
    if (!visible) return;
    this.frame.title = state.phase === 'loading'
      ? ' Session model · loading '
      : state.phase === 'selecting'
        ? ' Session model · switching '
        : state.phase === 'error'
          ? ' Session model · error '
          : ' Session model ';
    this.frame.bottomTitle = state.phase === 'selecting'
      ? ' Please wait '
      : ' ↑↓ · Enter switch · Esc ';
    this.content.content = formatModelPicker(state, width);
  }
}
