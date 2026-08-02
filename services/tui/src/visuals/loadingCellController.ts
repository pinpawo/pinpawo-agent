type TimerHandle = ReturnType<typeof setTimeout>;

export type LoadingCellControllerOptions = {
  onTick: (frame: number) => void;
  tickMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

const DEFAULT_TICK_MS = 240;

export class LoadingCellController {
  private active = false;
  private currentFrame = 0;
  private timer: TimerHandle | null = null;
  private destroyed = false;
  private readonly tickMs: number;
  private readonly setTimer: NonNullable<LoadingCellControllerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<LoadingCellControllerOptions['clearTimer']>;

  constructor(private readonly options: LoadingCellControllerOptions) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get frame() {
    return this.currentFrame;
  }

  sync(active: boolean) {
    if (this.destroyed || active === this.active) return;
    this.clear();
    this.active = active;
    this.currentFrame = 0;
    if (active) this.schedule();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.clear();
  }

  private schedule() {
    if (this.destroyed || !this.active) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.destroyed || !this.active) return;
      this.currentFrame += 1;
      this.options.onTick(this.currentFrame);
      this.schedule();
    }, this.tickMs);
  }

  private clear() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
