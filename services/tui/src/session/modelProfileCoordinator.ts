import type {
  AgentClientMessage,
  AgentInputModality,
  AgentModelProfileSummary,
  AgentServerMessage,
  AgentSessionSnapshot,
} from '@pinpawo/agent-session';

type TimerHandle = ReturnType<typeof setTimeout>;

export type ListModelProfilesResult = {
  sessionId: string;
  defaultProfileId: string;
  selectedProfileId: string;
  requiredInputModalities: AgentInputModality[];
  profiles: AgentModelProfileSummary[];
};

export class ModelProfileCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ModelProfileCommandError';
  }
}

type PendingModelCommand =
  | {
      operation: 'list';
      requestId: string;
      sessionId: string;
      timer: TimerHandle | null;
      resolve: (result: ListModelProfilesResult) => void;
      reject: (error: Error) => void;
    }
  | {
      operation: 'select';
      requestId: string;
      sessionId: string;
      modelProfileId: string;
      timer: TimerHandle | null;
      resolve: (snapshot: AgentSessionSnapshot) => void;
      reject: (error: Error) => void;
    };

type ModelProfileServerMessage = Extract<
  AgentServerMessage,
  {
    type:
      | 'model.list.result'
      | 'model.select.result'
      | 'model.select.error';
  }
>;

export type ModelProfileCoordinatorOptions = {
  requestIdFactory: () => string;
  send: (message: AgentClientMessage) => boolean;
  getUnavailableReason: () => string | null;
  getSessionId: () => string;
  onSelected: (snapshot: AgentSessionSnapshot) => void;
  timeoutMs: number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
};

export class ModelProfileCoordinator {
  private readonly commands = new Map<string, PendingModelCommand>();

  constructor(private readonly options: ModelProfileCoordinatorOptions) {}

  hasPending() {
    return this.commands.size > 0;
  }

  list(): Promise<ListModelProfilesResult> {
    const unavailable = this.options.getUnavailableReason();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const sessionId = this.options.getSessionId();
    const requestId = this.options.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingModelCommand = {
        operation: 'list',
        requestId,
        sessionId,
        timer: null,
        resolve,
        reject,
      };
      this.start(pending, {
        type: 'model.list',
        requestId,
        sessionId,
      });
    });
  }

  select(
    modelProfileId: string,
    expectedSessionId: string,
  ): Promise<AgentSessionSnapshot> {
    const profileId = modelProfileId.trim();
    if (!profileId) {
      return Promise.reject(new Error('model profile id is required'));
    }
    const unavailable = this.options.getUnavailableReason();
    if (unavailable) return Promise.reject(new Error(unavailable));
    const sessionId = this.options.getSessionId();
    if (sessionId !== expectedSessionId) {
      return Promise.reject(new ModelProfileCommandError(
        'the active session changed; reopen the model picker',
        'session_changed',
      ));
    }

    const requestId = this.options.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingModelCommand = {
        operation: 'select',
        requestId,
        sessionId,
        modelProfileId: profileId,
        timer: null,
        resolve,
        reject,
      };
      this.start(pending, {
        type: 'model.select',
        requestId,
        sessionId,
        modelProfileId: profileId,
      });
    });
  }

  cancelLists() {
    for (const command of [...this.commands.values()]) {
      if (command.operation !== 'list') continue;
      this.clear(command);
      command.reject(new Error('model list request cancelled'));
    }
  }

  cancelAll(message: string) {
    for (const command of [...this.commands.values()]) {
      this.clear(command);
      command.reject(new Error(message));
    }
  }

  handleMessage(message: ModelProfileServerMessage) {
    if (message.type === 'model.list.result') {
      const pending = this.commands.get(message.requestId);
      if (pending?.operation !== 'list') return;
      this.clear(pending);
      if (message.sessionId !== pending.sessionId) {
        pending.reject(new Error(
          'model list response did not match the requested session',
        ));
        return;
      }
      pending.resolve({
        sessionId: message.sessionId,
        defaultProfileId: message.defaultProfileId,
        selectedProfileId: message.selectedProfileId,
        requiredInputModalities: [...message.requiredInputModalities],
        profiles: message.profiles.map((profile) => ({
          ...profile,
          inputModalities: [...profile.inputModalities],
          issues: [...profile.issues],
        })),
      });
      return;
    }

    if (message.type === 'model.select.result') {
      const pending = this.commands.get(message.requestId);
      if (pending?.operation !== 'select') return;
      this.clear(pending);
      if (
        message.sessionId !== pending.sessionId
        || message.selectedProfileId !== pending.modelProfileId
        || message.snapshot.session.sessionId !== pending.sessionId
      ) {
        pending.reject(new Error(
          'model selection response did not match the request',
        ));
        return;
      }
      this.options.onSelected(message.snapshot);
      pending.resolve(message.snapshot);
      return;
    }

    const pending = this.commands.get(message.requestId);
    if (pending?.operation !== 'select') return;
    this.clear(pending);
    pending.reject(new ModelProfileCommandError(message.message, message.code));
  }

  private start(
    command: PendingModelCommand,
    message: AgentClientMessage,
  ) {
    this.commands.set(command.requestId, command);
    command.timer = this.options.setTimer(() => {
      if (this.commands.get(command.requestId) !== command) return;
      this.commands.delete(command.requestId);
      command.timer = null;
      command.reject(new Error(
        `model ${command.operation} request timed out`,
      ));
    }, this.options.timeoutMs);
    if (!this.options.send(message)) {
      this.clear(command);
      command.reject(new Error(
        `model ${command.operation} request could not be sent`,
      ));
    }
  }

  private clear(command: PendingModelCommand) {
    if (command.timer) {
      this.options.clearTimer(command.timer);
      command.timer = null;
    }
    this.commands.delete(command.requestId);
  }
}
