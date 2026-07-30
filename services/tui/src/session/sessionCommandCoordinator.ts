import type {
  AgentClientMessage,
  AgentServerMessage,
  AgentSessionSnapshot,
  AgentSessionSummary,
} from '@pinpawo/agent-session';

type TimerHandle = ReturnType<typeof setTimeout>;

export type ResumeSessionResult = {
  session: AgentSessionSummary;
  snapshot: AgentSessionSnapshot;
};

export type StartNewSessionResult = ResumeSessionResult;

type PendingSessionCommand =
  | {
      operation: 'list';
      requestId: string;
      timer: TimerHandle | null;
      resolve: (sessions: AgentSessionSummary[]) => void;
      reject: (error: Error) => void;
    }
  | {
      operation: 'new';
      requestId: string;
      timer: TimerHandle | null;
      resolve: (result: StartNewSessionResult) => void;
      reject: (error: Error) => void;
    }
  | {
      operation: 'resume';
      requestId: string;
      sessionId: string;
      timer: TimerHandle | null;
      resolve: (result: ResumeSessionResult) => void;
      reject: (error: Error) => void;
    };

export type SessionCommandCoordinatorOptions = {
  requestIdFactory: () => string;
  send: (message: AgentClientMessage) => boolean;
  getUnavailableReason: () => string | null;
  onSnapshot: (snapshot: AgentSessionSnapshot) => void;
  timeoutMs: number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
};

export class SessionCommandCoordinator {
  private readonly commands = new Map<string, PendingSessionCommand>();

  constructor(private readonly options: SessionCommandCoordinatorOptions) {}

  hasPending() {
    return this.commands.size > 0;
  }

  startNewSession(): Promise<StartNewSessionResult> {
    const unavailable = this.unavailableReason();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.options.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingSessionCommand = {
        operation: 'new',
        requestId,
        timer: null,
        resolve,
        reject,
      };
      this.start(pending, { type: 'session.new', requestId });
    });
  }

  listSessions(): Promise<AgentSessionSummary[]> {
    const unavailable = this.unavailableReason();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.options.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingSessionCommand = {
        operation: 'list',
        requestId,
        timer: null,
        resolve,
        reject,
      };
      this.start(pending, { type: 'session.list', requestId });
    });
  }

  resumeSession(sessionId: string): Promise<ResumeSessionResult> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return Promise.reject(new Error('session id is required'));
    }
    const unavailable = this.unavailableReason();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.options.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingSessionCommand = {
        operation: 'resume',
        requestId,
        sessionId: normalizedSessionId,
        timer: null,
        resolve,
        reject,
      };
      this.start(pending, {
        type: 'session.resume',
        requestId,
        sessionId: normalizedSessionId,
      });
    });
  }

  handleMessage(message: AgentServerMessage) {
    if (message.type === 'session.list.result') {
      const pending = this.commands.get(message.requestId);
      if (pending?.operation !== 'list') return true;
      this.clear(pending);
      pending.resolve(message.sessions);
      return true;
    }

    if (message.type === 'session.new.result') {
      const pending = this.commands.get(message.requestId);
      if (pending?.operation !== 'new') return true;
      this.clear(pending);
      this.options.onSnapshot(message.snapshot);
      pending.resolve({
        session: message.session,
        snapshot: message.snapshot,
      });
      return true;
    }

    if (message.type === 'session.resume.result') {
      const pending = this.commands.get(message.requestId);
      if (pending?.operation !== 'resume') return true;
      if (
        pending.sessionId !== message.session.id
        || pending.sessionId !== message.snapshot.session.sessionId
      ) {
        this.clear(pending);
        pending.reject(new Error(
          'session resume response did not match the requested session',
        ));
        return true;
      }
      this.clear(pending);
      this.options.onSnapshot(message.snapshot);
      pending.resolve({
        session: message.session,
        snapshot: message.snapshot,
      });
      return true;
    }

    if (message.type !== 'session.error') return false;
    const pending = this.commands.get(message.requestId);
    if (!pending || pending.operation !== message.operation) return false;
    this.clear(pending);
    pending.reject(new Error(message.message));
    return true;
  }

  cancelAll(message: string) {
    for (const command of [...this.commands.values()]) {
      this.clear(command);
      command.reject(new Error(message));
    }
  }

  private unavailableReason() {
    const unavailable = this.options.getUnavailableReason();
    if (unavailable) return unavailable;
    if (this.commands.size > 0) {
      return 'another session command is already in progress';
    }
    return null;
  }

  private start(
    command: PendingSessionCommand,
    message: AgentClientMessage,
  ) {
    this.commands.set(command.requestId, command);
    command.timer = this.options.setTimer(() => {
      if (this.commands.get(command.requestId) !== command) return;
      this.commands.delete(command.requestId);
      command.timer = null;
      command.reject(new Error(
        `session ${command.operation} request timed out`,
      ));
    }, this.options.timeoutMs);
    if (!this.options.send(message)) {
      this.clear(command);
      command.reject(new Error(
        `session ${command.operation} request could not be sent`,
      ));
    }
  }

  private clear(command: PendingSessionCommand) {
    if (command.timer) {
      this.options.clearTimer(command.timer);
      command.timer = null;
    }
    this.commands.delete(command.requestId);
  }
}
