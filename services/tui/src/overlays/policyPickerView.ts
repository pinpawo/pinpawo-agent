import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import {
  formatPolicyPicker,
  type PolicyPickerState,
} from './policyPickerModel';

export class PolicyPickerView {
  readonly frame: BoxRenderable;
  private readonly content: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.frame = new BoxRenderable(renderer, {
      id: 'policy-picker',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 10,
      visible: false,
      border: true,
      title: ' Review policy ',
      titleColor: '#f0a6ca',
      bottomTitle: ' ↑↓ · Enter save · Esc ',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
    });
    this.content = new TextRenderable(renderer, {
      id: 'policy-picker-content',
      content: '',
      width: '100%',
      height: '100%',
    });
    this.frame.add(this.content);
  }

  render(state: PolicyPickerState, width: number) {
    const visible = state.phase !== 'closed';
    this.frame.visible = visible;
    if (!visible) return;

    this.frame.title = state.phase === 'saving'
      ? ' Review policy · saving '
      : state.phase === 'error'
        ? ' Review policy · error '
        : ' Review policy ';
    this.frame.bottomTitle = state.phase === 'saving'
      ? ' Please wait '
      : ' ↑↓ · Enter save · Esc ';
    this.content.content = formatPolicyPicker(state, width);
  }
}
