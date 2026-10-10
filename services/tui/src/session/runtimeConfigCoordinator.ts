import type {
  AgentClientMessage,
  AgentServerMessage,
  ToolAuthorizationSafetyLevel,
  ToolAuthorizationMode,
} from '@pinpawo/agent-session';

type TimerHandle = ReturnType<typeof setTimeout>;

export type UpdateToolAuthorizationModeResult = {
  toolAuthorizationMode: ToolAuthorizationMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
};

type PendingRuntimeConfigUpdate = {
  requestId: string;
  toolAuthorizationMode: ToolAuthorizationMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  timer: TimerHandle | null;
  resolve: (result: UpdateToolAuthorizationModeResult) => void;
  reject: (error: Error) => void;
};

type RuntimeConfigServerMessage = Extract<
  AgentServerMessage,
  { type: 'runtime_config.result' | 'runtime_config.error' }
>;

export type RuntimeConfigCoordinatorOptions = {
  requestIdFactory: () => string;
  send: (message: AgentClientMessage) => boolean;
  getUnavailableReason: () => string | null;
  onUpdated: (
    toolAuthorizationMode: ToolAuthorizationMode,
    autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel,
  ) => void;
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

  updateToolAuthorizationMode(
    toolAuthorizationMode: ToolAuthorizationMode,
    autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel,
  ): Promise<UpdateToolAuthorizationModeResult> {
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
        toolAuthorizationMode,
        autoAuthorizationSafetyLevel,
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
        toolAuthorizationMode,
        autoAuthorizationSafetyLevel,
      })) {
        this.clear(pending);
        reject(new Error('runtime config update could not be sent'));
      }
    });
  }

  handleMessage(message: RuntimeConfigServerMessage) {
    const pending = this.pending;
    if (!pending || pending.requestId !== message.requestId) return;
    this.clear(pending);
    if (message.type === 'runtime_config.error') {
      pending.reject(new Error(message.message));
      return;
    }
    if (message.toolAuthorizationMode !== pending.toolAuthorizationMode) {
      pending.reject(new Error(
        'runtime config response did not match the requested policy',
      ));
      return;
    }
    const { autoAuthorizationSafetyLevel } = message;
    if (autoAuthorizationSafetyLevel !== pending.autoAuthorizationSafetyLevel) {
      pending.reject(new Error(
        'runtime config response did not match the requested safety level',
      ));
      return;
    }
    this.options.onUpdated(message.toolAuthorizationMode, autoAuthorizationSafetyLevel);
    pending.resolve({
      toolAuthorizationMode: message.toolAuthorizationMode,
      autoAuthorizationSafetyLevel,
    });
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
