import type { LocalAgentControlServerMessage } from './localAgentProtocol';
import type { LocalAgentOperationEvent } from './events/localAgentEvent';
import {
  clearInflightOperationTimer,
  createInflightOperationRun,
  finishInflightOperations,
  type InflightOperationRun,
  type TerminalOperationPhase,
} from './inflightOperationRun';

type InflightInterruptMessage = Extract<
  LocalAgentControlServerMessage,
  { type: 'interrupting' | 'interrupted' }
>;

type InflightRequestControllerOptions<TKey> = {
  forceInterruptMs: number;
  emitOperation: (key: TKey, event: LocalAgentOperationEvent) => void;
  sendControl: (key: TKey, message: InflightInterruptMessage) => void;
  log?: (message: string) => void;
  logPrefix?: string;
};

type StartInflightRequestOptions = {
  interruptPrevious?: boolean;
  notifyPrevious?: boolean;
  previousPhase?: TerminalOperationPhase;
};

type InterruptInflightRequestOptions = {
  requestId?: string;
};

export class InflightRequestController<TKey> {
  private readonly requests = new Map<TKey, InflightOperationRun>();
  private readonly forceInterruptMs: number;
  private readonly emitOperation: (key: TKey, event: LocalAgentOperationEvent) => void;
  private readonly sendControl: (key: TKey, message: InflightInterruptMessage) => void;
  private readonly log: (message: string) => void;
  private readonly logPrefix: string;

  constructor(options: InflightRequestControllerOptions<TKey>) {
    this.forceInterruptMs = options.forceInterruptMs;
    this.emitOperation = options.emitOperation;
    this.sendControl = options.sendControl;
    this.log = options.log ?? console.warn;
    this.logPrefix = options.logPrefix ?? 'local-agent';
  }

  get(key: TKey) {
    return this.requests.get(key) ?? null;
  }

  start(
    key: TKey,
    requestId: string,
    options: StartInflightRequestOptions = {},
  ) {
    const previous = this.get(key);
    if (previous && options.interruptPrevious) {
      if (options.notifyPrevious) {
        this.sendInterrupted(key, previous);
      } else {
        this.finish(key, previous, options.previousPhase ?? 'interrupted');
      }
      previous.controller.abort();
      this.clear(key, previous);
    }

    const run = createInflightOperationRun(requestId);
    this.requests.set(key, run);
    return run;
  }

  isCurrent(key: TKey, run: InflightOperationRun) {
    return this.requests.get(key) === run;
  }

  isCurrentActive(key: TKey, run: InflightOperationRun) {
    return this.isCurrent(key, run) && !run.controller.signal.aborted;
  }

  clearTimer(run: InflightOperationRun) {
    clearInflightOperationTimer(run);
  }

  clear(key: TKey, run: InflightOperationRun | null = this.get(key)) {
    if (!run) {
      return;
    }
    this.clearTimer(run);
    if (this.requests.get(key) === run) {
      this.requests.delete(key);
    }
  }

  abortAndClear(key: TKey, run: InflightOperationRun | null = this.get(key)) {
    if (!run) {
      return;
    }
    this.clearTimer(run);
    run.controller.abort();
    if (this.requests.get(key) === run) {
      this.requests.delete(key);
    }
  }

  finish(
    key: TKey,
    run: InflightOperationRun,
    phase: TerminalOperationPhase,
    error?: unknown,
  ) {
    finishInflightOperations(run, phase, (event) => {
      this.emitOperation(key, event);
    }, error);
  }

  sendInterrupted(key: TKey, run: InflightOperationRun) {
    if (run.interruptedSent) {
      return;
    }
    run.interruptedSent = true;
    this.finish(key, run, 'interrupted');
    this.sendControl(key, {
      type: 'interrupted',
      requestId: run.requestId,
      message: 'interrupted',
    });
  }

  interrupt(key: TKey, options: InterruptInflightRequestOptions = {}) {
    const run = this.get(key);
    if (!run) {
      return null;
    }
    if (options.requestId && run.requestId !== options.requestId) {
      return null;
    }

    this.sendControl(key, {
      type: 'interrupting',
      requestId: run.requestId,
      message: 'interrupting',
    });
    run.controller.abort();
    if (!run.interruptTimer) {
      run.interruptTimer = setTimeout(() => {
        if (!this.isCurrent(key, run) || !run.controller.signal.aborted) {
          return;
        }
        this.sendInterrupted(key, run);
        this.clear(key, run);
        this.log(`[${this.logPrefix}] force interrupted requestId=${run.requestId}`);
      }, this.forceInterruptMs);
    }
    return run;
  }
}
