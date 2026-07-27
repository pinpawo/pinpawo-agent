import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  type CliRenderer,
} from '@opentui/core';
import {
  buildNoticeOverlayViewModel,
  type NoticeOverlayState,
} from './noticeOverlayModel';

export class NoticeOverlayView {
  readonly frame: BoxRenderable;
  private readonly content: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.frame = new BoxRenderable(renderer, {
      id: 'notice-overlay',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 15,
      visible: false,
      border: true,
      borderColor: '#d6a84b',
      titleColor: '#d6a84b',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: RGBA.defaultBackground(),
      overflow: 'hidden',
    });
    this.content = new TextRenderable(renderer, {
      id: 'notice-overlay-content',
      width: '100%',
      height: '100%',
      content: '',
      overflow: 'hidden',
    });
    this.frame.add(this.content);
  }

  render(state: NoticeOverlayState, width: number) {
    if (state.phase === 'closed') {
      this.frame.visible = false;
      return;
    }
    const model = buildNoticeOverlayViewModel(state, width);
    this.frame.visible = true;
    this.frame.title = model.title;
    this.frame.bottomTitle = model.bottomTitle;
    this.content.content = model.content;
  }
}
