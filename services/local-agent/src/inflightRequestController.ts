import type { LocalAgentControlServerMessage } from './localAgentProtocol';
import type { AgentOperationEvent } from '@pinpawo/agent-session';
import {
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
  emitOperation: (key: TKey, event: AgentOperationEvent) => void;
  sendControl: (key: TKey, message: InflightInterruptMessage) => void;
};

type StartInflightRequestOptions = {
  observeOperation?: (event: AgentOperationEvent) => void;
};

type InterruptInflightRequestOptions = {
  requestId?: string;
};

export class InflightRequestController<TKey> {
  private readonly requests = new Map<TKey, Set<InflightOperationRun>>();
  private readonly emitOperation: (key: TKey, event: AgentOperationEvent) => void;
  private readonly sendControl: (key: TKey, message: InflightInterruptMessage) => void;
  private readonly operationObservers = new WeakMap<
    InflightOperationRun,
    (event: AgentOperationEvent) => void
  >();

  constructor(options: InflightRequestControllerOptions<TKey>) {
    this.emitOperation = options.emitOperation;
    this.sendControl = options.sendControl;
  }

  get(key: TKey) {
    return [...(this.requests.get(key) ?? [])].at(-1) ?? null;
  }

  hasActiveRequest() {
    return [...this.requests.values()].some((runs) => runs.size > 0);
  }

  start(
    key: TKey,
    requestId: string,
    options: StartInflightRequestOptions = {},
  ) {
    const run = createInflightOperationRun(requestId);
    if (options.observeOperation) {
      this.operationObservers.set(run, options.observeOperation);
    }
    const runs = this.requests.get(key) ?? new Set<InflightOperationRun>();
    runs.add(run);
    this.requests.set(key, runs);
    return run;
  }

  clear(key: TKey, run: InflightOperationRun | null) {
    if (!run) {
      return;
    }
    this.operationObservers.delete(run);
    const runs = this.requests.get(key);
    runs?.delete(run);
    if (runs?.size === 0) {
      this.requests.delete(key);
    }
  }

  abortAll(key: TKey) {
    for (const run of this.requests.get(key) ?? []) {
      run.controller.abort();
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
      this.operationObservers.get(run)?.(event);
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
    const run = options.requestId
      ? [...(this.requests.get(key) ?? [])]
        .find((candidate) => candidate.requestId === options.requestId) ?? null
      : this.get(key);
    if (!run) {
      return null;
    }

    this.sendControl(key, {
      type: 'interrupting',
      requestId: run.requestId,
      message: 'interrupting',
    });
    run.controller.abort();
    return run;
  }
}
