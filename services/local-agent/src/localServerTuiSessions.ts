import type { BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import { buildLocalChatAgentInput } from './agentChannel';
import { LocalAgentGraphService } from './agentGraphService';
import { readFinalMessageText } from './agentStreamEvents';
import { loadAgentContext } from './contextLoader';
import { FileSaver } from './fileSaver';
import type { LocalServerDeps } from './localServerTypes';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import {
  createTuiSession,
  ensureActiveTuiSession,
  listTuiSessions,
  loadTuiSessionState,
  resumeTuiSession,
  saveTuiSessionState,
  updateTuiSessionSummary,
  type TuiSessionRecord,
  type TuiSessionState,
} from './tuiSessionRegistry';

export type TuiHistoryMessage = {
  role: string;
  text: string;
};

export type ActivePendingReview = {
  sessionId: string;
  review: ReviewSpec;
};

export type TuiSessionCheckpointer = BaseCheckpointSaver & Pick<FileSaver, 'deleteThread'>;
type TuiSessionGraphService = Pick<LocalAgentGraphService, 'readThreadMessages' | 'readThreadState'>;

export function readTuiHistoryMessages(messages: BaseMessage[]): TuiHistoryMessage[] {
  return messages.flatMap((message) => {
    const type = message._getType();
    if (type !== 'human' && type !== 'ai') {
      return [];
    }
    if (type === 'ai') {
      const pinpawo = message.additional_kwargs?.pinpawo;
      if (pinpawo && typeof pinpawo === 'object' && 'lane' in pinpawo) {
        return [];
      }
    }
    const text = readFinalMessageText(message);
    if (!text) {
      return [];
    }
    return [{
      role: type === 'human' ? 'user' : 'assistant',
      text,
    }];
  });
}

export function summarizeTuiHistoryMessages(
  messages: TuiHistoryMessage[],
  updatedAt = new Date().toISOString(),
) {
  const titleSource = messages.find((message) => message.role === 'user' && message.text.trim())
    ?? messages.find((message) => message.text.trim());
  const title = titleSource
    ? titleSource.text.replace(/\s+/g, ' ').trim().slice(0, 60)
    : '空会话';
  return {
    title,
    messageCount: messages.length,
    updatedAt,
  };
}

function createSessionStateStore(options: {
  runtimeConfig: LocalAgentRuntimeConfig;
  state?: TuiSessionState;
  saveState?: (state: TuiSessionState) => void;
  sessionStatePath?: string;
}) {
  const sessionStatePath = options.sessionStatePath ?? options.runtimeConfig.tuiSessionPath;
  return {
    state: options.state ?? loadTuiSessionState(sessionStatePath),
    saveState: options.saveState ?? ((state: TuiSessionState) => saveTuiSessionState(state, sessionStatePath)),
  };
}

function createSessionCheckpointer(options: {
  runtimeConfig: LocalAgentRuntimeConfig;
  checkpointPath?: string;
}) {
  return new FileSaver(options.checkpointPath ?? options.runtimeConfig.tuiCheckpointPath);
}

export class LocalServerTuiSessionService {
  private state: TuiSessionState;
  private saveState: (state: TuiSessionState) => void;
  private checkpointer: TuiSessionCheckpointer;
  private readonly graphService: TuiSessionGraphService;
  private readonly loadContext: typeof loadAgentContext;

  constructor(options: {
    state?: TuiSessionState;
    saveState?: (state: TuiSessionState) => void;
    checkpointer?: TuiSessionCheckpointer;
    graphService?: TuiSessionGraphService;
    loadContext?: typeof loadAgentContext;
    runtimeConfig?: LocalAgentRuntimeConfig;
    sessionStatePath?: string;
    checkpointPath?: string;
  } = {}) {
    const runtimeConfig = options.runtimeConfig ?? buildLocalAgentRuntimeConfig();
    const store = createSessionStateStore({
      runtimeConfig,
      state: options.state,
      saveState: options.saveState,
      sessionStatePath: options.sessionStatePath,
    });
    this.state = store.state;
    this.saveState = store.saveState;
    this.checkpointer = options.checkpointer ?? createSessionCheckpointer({
      runtimeConfig,
      checkpointPath: options.checkpointPath,
    });
    this.graphService = options.graphService ?? new LocalAgentGraphService();
    this.loadContext = options.loadContext ?? loadAgentContext;
  }

  switchRuntimeConfig(runtimeConfig: LocalAgentRuntimeConfig) {
    const store = createSessionStateStore({ runtimeConfig });
    this.state = store.state;
    this.saveState = store.saveState;
    this.checkpointer = createSessionCheckpointer({ runtimeConfig });
  }

  getActiveSession(petId: string) {
    const session = ensureActiveTuiSession(this.state, petId);
    this.save();
    return session;
  }

  getChatThreadId(petId: string) {
    return this.getActiveSession(petId).threadId;
  }

  getActiveSessionId(petId: string) {
    return this.getActiveSession(petId).id;
  }

  createNewSession(petId: string) {
    this.getActiveSession(petId);
    const next = createTuiSession(this.state, petId);
    this.save();
    return next;
  }

  async resetSession(petId: string, options: { deletePrevious?: boolean } = {}) {
    const previous = this.getActiveSession(petId);
    const next = createTuiSession(this.state, petId);
    if (options.deletePrevious) {
      await this.checkpointer.deleteThread(previous.threadId);
      delete this.state.sessions[previous.id];
    }
    this.save();
    return next;
  }

  buildChatSetup(
    deps: LocalServerDeps,
    ctx: Awaited<ReturnType<typeof loadAgentContext>>,
    threadId = this.getChatThreadId(deps.actorId),
  ) {
    const session = Object.values(this.state.sessions)
      .find((candidate) => candidate.threadId === threadId)
      ?? this.getActiveSession(deps.actorId);
    return buildLocalChatAgentInput({
      context: ctx,
      userMessage: '',
      llmConfig: deps.llmConfig,
      toolkits: [...(deps.pluginToolkits ?? []), ...(deps.localToolkits ?? [])],
      extraCapabilities: deps.localCapabilities,
      threadId,
      interfaceKind: 'tui',
      dryRun: false,
      checkpoint: this.checkpointer,
      userCapabilities: deps.userCapabilities,
      capabilityArtifactStore: deps.capabilityArtifactStore,
      workdir: deps.workdir,
      sessionStartedAt: session.createdAt,
    });
  }

  async readSessionHistoryMessages(
    deps: LocalServerDeps,
    session: TuiSessionRecord,
  ) {
    const ctx = await this.loadContext(deps.actorId);
    const setup = this.buildChatSetup(deps, ctx, session.threadId);
    const messages = await this.graphService.readThreadMessages(setup);
    return readTuiHistoryMessages(messages);
  }

  updateSessionSummaryFromHistory(
    session: TuiSessionRecord,
    messages: TuiHistoryMessage[],
  ) {
    updateTuiSessionSummary(this.state, session.id, summarizeTuiHistoryMessages(messages));
    this.save();
  }

  async refreshActiveSessionSummary(deps: LocalServerDeps) {
    try {
      const session = this.getActiveSession(deps.actorId);
      const messages = await this.readSessionHistoryMessages(deps, session);
      this.updateSessionSummaryFromHistory(session, messages);
    } catch (err) {
      console.warn('[local-server] failed to refresh TUI session summary:', err instanceof Error ? err.message : err);
    }
  }

  async readActivePendingReview(deps: LocalServerDeps): Promise<ActivePendingReview | null> {
    const session = this.getActiveSession(deps.actorId);
    const ctx = await this.loadContext(deps.actorId);
    const setup = this.buildChatSetup(deps, ctx, session.threadId);
    const threadState = await this.graphService.readThreadState(setup);
    if (!threadState.pendingHumanReview) {
      return null;
    }
    return {
      sessionId: session.id,
      review: threadState.pendingHumanReview.review,
    };
  }

  async loadHistory(deps: LocalServerDeps) {
    const session = this.getActiveSession(deps.actorId);
    const messages = await this.readSessionHistoryMessages(deps, session);
    updateTuiSessionSummary(this.state, session.id, summarizeTuiHistoryMessages(messages, session.updatedAt));
    this.save();
    return messages;
  }

  async listSessions(deps: LocalServerDeps) {
    this.getActiveSession(deps.actorId);
    const sessions = listTuiSessions(this.state, deps.actorId);
    const enriched = await Promise.all(sessions.map(async (session) => {
      const messages = await this.readSessionHistoryMessages(deps, session);
      const summary = summarizeTuiHistoryMessages(messages, session.updatedAt);
      const updated = updateTuiSessionSummary(this.state, session.id, summary) ?? session;
      return {
        ...updated,
        active: session.active,
        messageCount: summary.messageCount,
        title: summary.title,
        updatedAt: summary.updatedAt,
      };
    }));
    this.save();
    return enriched.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async resumeSession(deps: LocalServerDeps, sessionId: string) {
    const candidate = this.state.sessions[sessionId];
    if (!candidate || candidate.petId !== deps.actorId) {
      throw new Error('session not found');
    }
    const messages = await this.readSessionHistoryMessages(deps, candidate);
    const session = resumeTuiSession(this.state, deps.actorId, sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    this.save();
    updateTuiSessionSummary(this.state, session.id, summarizeTuiHistoryMessages(messages, session.updatedAt));
    this.save();
    return {
      session: {
        ...(this.state.sessions[session.id] ?? session),
        active: true,
      },
      messages,
    };
  }

  private save() {
    this.saveState(this.state);
  }
}
