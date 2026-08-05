import type { AgentRunView } from '@pinpawo/agent-session';
import {
  LOADING_CELL_FRAME_COUNT,
} from '../visuals/loadingCells';

const DEFAULT_TICK_MS = 240;
const DEFAULT_LONG_WAIT_MS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export type LiveActivityControllerOptions = {
  onTick: (frame: number) => void;
  onLongWait: () => void;
  tickMs?: number;
  longWaitMs?: number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export class LiveActivityController {
  private run: AgentRunView | null = null;
  private stateKey: string | null = null;
  private pulseTimer: TimerHandle | null = null;
  private longWaitTimer: TimerHandle | null = null;
  private destroyed = false;
  private currentFrame = 0;
  private waitingLong = false;
  private readonly tickMs: number;
  private readonly longWaitMs: number;
  private readonly setTimer: NonNullable<
    LiveActivityControllerOptions['setTimer']
  >;
  private readonly clearTimer: NonNullable<
    LiveActivityControllerOptions['clearTimer']
  >;

  constructor(
    private readonly options: LiveActivityControllerOptions,
  ) {
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.longWaitMs = options.longWaitMs ?? DEFAULT_LONG_WAIT_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get frame() {
    return this.currentFrame;
  }

  get longWaiting() {
    return this.waitingLong;
  }

  sync(run: AgentRunView | null) {
    if (this.destroyed) return;
    const stateKey = liveActivityStateKey(run);
    if (stateKey === this.stateKey) return;

    this.clear();
    this.run = run;
    this.stateKey = stateKey;
    this.currentFrame = 0;
    this.waitingLong = false;
    this.schedulePulse();
    this.scheduleLongWait();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    this.run = null;
    this.stateKey = null;
  }

  private schedulePulse() {
    if (
      this.destroyed
      || !this.run
      || this.run.state !== 'running'
    ) {
      return;
    }
    this.pulseTimer = this.setTimer(() => {
      this.pulseTimer = null;
      if (this.destroyed || !this.run) return;
      this.currentFrame += 1;
      this.options.onTick(this.currentFrame);
      this.schedulePulse();
    }, this.tickMs);
  }

  private scheduleLongWait() {
    if (
      this.destroyed
      || !this.run
      || this.run.state !== 'running'
    ) {
      return;
    }
    this.longWaitTimer = this.setTimer(() => {
      this.longWaitTimer = null;
      if (
        this.destroyed
        || !this.run
        || this.run.state !== 'running'
      ) {
        return;
      }
      this.waitingLong = true;
      this.options.onLongWait();
    }, this.longWaitMs);
  }

  private clear() {
    if (this.pulseTimer !== null) {
      this.clearTimer(this.pulseTimer);
      this.pulseTimer = null;
    }
    if (this.longWaitTimer !== null) {
      this.clearTimer(this.longWaitTimer);
      this.longWaitTimer = null;
    }
  }
}

export function liveActivityStateKey(run: AgentRunView | null) {
  if (!run) return null;
  return run.state === 'running'
    ? `${run.requestId}:${run.state}:${run.activity}`
    : `${run.requestId}:${run.state}`;
}

export { LOADING_CELL_FRAME_COUNT };
