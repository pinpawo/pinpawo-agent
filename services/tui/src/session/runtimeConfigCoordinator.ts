import type {
  AgentClientMessage,
  AgentServerMessage,
  BuiltinGlobalReviewPolicyMode,
} from '@pinpawo/agent-session';

type TimerHandle = ReturnType<typeof setTimeout>;

export type UpdateGlobalReviewPolicyResult = {
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
};

type PendingRuntimeConfigUpdate = {
  requestId: string;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  timer: TimerHandle | null;
  resolve: (result: UpdateGlobalReviewPolicyResult) => void;
  reject: (error: Error) => void;
};

export type RuntimeConfigCoordinatorOptions = {
  requestIdFactory: () => string;
  send: (message: AgentClientMessage) => boolean;
  getUnavailableReason: () => string | null;
  onUpdated: (globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode) => void;
  timeoutMs: number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
};

export class RuntimeConfigCoordinator {
  private pending: PendingRuntimeConfigUpdate | null = null;

  constructor(private readonly options: RuntimeConfigCoordinatorOptions) {}

  hasPending() {
    return this.pending !== null;
  }

  updateGlobalReviewPolicy(
    globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode,
  ): Promise<UpdateGlobalReviewPolicyResult> {
    const unavailable = this.options.getUnavailableReason();
    if (unavailable) return Promise.reject(new Error(unavailable));
    if (this.pending) {
      return Promise.reject(new Error(
        'runtime config is already being updated',
      ));
    }

    const requestId = this.options.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingRuntimeConfigUpdate = {
        requestId,
        globalReviewPolicyMode,
        timer: null,
        resolve,
        reject,
      };
      this.pending = pending;
      pending.timer = this.options.setTimer(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        pending.timer = null;
        pending.reject(new Error('runtime config update timed out'));
      }, this.options.timeoutMs);
      if (!this.options.send({
        type: 'runtime_config.update',
        requestId,
        globalReviewPolicyMode,
      })) {
        this.clear(pending);
        reject(new Error('runtime config update could not be sent'));
      }
    });
  }

  handleMessage(message: AgentServerMessage) {
    if (
      message.type !== 'runtime_config.result'
      && message.type !== 'runtime_config.error'
    ) {
      return false;
    }
    const pending = this.pending;
    if (!pending || pending.requestId !== message.requestId) return true;
    this.clear(pending);
    if (message.type === 'runtime_config.error') {
      pending.reject(new Error(message.message));
      return true;
    }
    if (message.globalReviewPolicyMode !== pending.globalReviewPolicyMode) {
      pending.reject(new Error(
        'runtime config response did not match the requested policy',
      ));
      return true;
    }
    this.options.onUpdated(message.globalReviewPolicyMode);
    pending.resolve({
      globalReviewPolicyMode: message.globalReviewPolicyMode,
    });
    return true;
  }

  cancel(message: string) {
    const pending = this.pending;
    if (!pending) return;
    this.clear(pending);
    pending.reject(new Error(message));
  }

  private clear(update: PendingRuntimeConfigUpdate) {
    if (update.timer) {
      this.options.clearTimer(update.timer);
      update.timer = null;
    }
    if (this.pending === update) {
      this.pending = null;
    }
  }
}
