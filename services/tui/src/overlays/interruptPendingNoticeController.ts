import type { NoticeOverlayState } from './noticeOverlayModel';

type TimerHandle = ReturnType<typeof setTimeout>;

export type InterruptPendingNoticeControllerOptions = {
  onPendingTooLong: (requestId: string) => void;
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

const DEFAULT_DELAY_MS = 10_000;

export class InterruptPendingNoticeController {
  private readonly onPendingTooLong: (requestId: string) => void;
  private readonly delayMs: number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private requestId: string | null = null;
  private timer: TimerHandle | null = null;

  constructor(options: InterruptPendingNoticeControllerOptions) {
    this.onPendingTooLong = options.onPendingTooLong;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  sync(state: NoticeOverlayState) {
    const nextRequestId = state.phase === 'interrupting'
      ? state.requestId
      : null;
    if (nextRequestId === this.requestId) return;
    this.clear();
    if (!nextRequestId) return;

    this.requestId = nextRequestId;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.requestId === nextRequestId) {
        this.onPendingTooLong(nextRequestId);
      }
    }, this.delayMs);
  }

  destroy() {
    this.clear();
  }

  private clear() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.requestId = null;
  }
}
