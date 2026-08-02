import { resolve } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type {
  AgentInputModality,
  AgentLocalAttachment,
} from '@pinpawo/agent-session';
import {
  readMessageCreatedAtUtc,
  readLatestProviderInputTokens,
  readMessagesTokenUsage,
  type ReviewSpec,
  type TokenUsageSnapshot,
} from '@pinpawo/pet-agent';
import { buildLocalChatAgentInput } from './agentChannel';
import { createCapabilityDiagnosticReporter } from './agentRegistryPreparation';
import { LocalAgentGraphService } from './agentGraphService';
import { readFinalMessageText } from './agentStreamEvents';
import { loadAgentContext } from './contextLoader';
import { FileSaver } from './fileSaver';
import { getLocalServerRuntimeConfig, type LocalServerDeps } from './localServerTypes';
import {
  createAdmittedLocalChatHumanMessage,
  createLocalChatHumanMessage,
  readLocalChatDisplayText,
} from './localChatAttachments';
import { LocalChatImageStore } from './localImageAttachments';
import {
  missingInputModalities,
  supportsInputModalities,
} from './modelProfiles';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import {
  addTuiSessionRequiredInputModalities,
  createTuiSession,
  ensureActiveTuiSession,
  listTuiSessions,
  loadTuiSessionState,
  resumeTuiSession,
  saveTuiSessionState,
  updateTuiSessionModelProfile,
  updateTuiSessionSummary,
  type TuiSessionRecord,
  type TuiSessionState,
} from './tuiSessionRegistry';

export type TuiCheckpointMessage = {
  role: 'user' | 'assistant';
  text: string;
  createdAt?: string;
} | {
  role: 'subagent';
  requestId: string;
  text: string;
  createdAt?: string;
};

type TuiCheckpointMessageSource =
  | { role: 'user' | 'assistant' }
  | { role: 'subagent'; requestId: string };

export type ActivePendingReview = {
  sessionId: string;
  interruptId?: string;
  review: ReviewSpec;
  reviews?: ReviewSpec[];
};

export type TuiCheckpointPoint = {
  sessionId: string;
  modelProfileId: string;
  requiredInputModalities: AgentInputModality[];
  messages: TuiCheckpointMessage[];
  sessionTokenUsage: (TokenUsageSnapshot & { scope: 'session' }) | null;
  pendingReview: ActivePendingReview | null;
};

export type TuiSessionCheckpointer = BaseCheckpointSaver & Pick<FileSaver, 'deleteThread'>;
type TuiSessionGraphService = Pick<LocalAgentGraphService, 'readThreadState'>;

export function readTuiCheckpointMessages(messages: BaseMessage[]): TuiCheckpointMessage[] {
  return messages.flatMap((message) => {
    const source = readTuiCheckpointMessageSource(message);
    if (!source) return [];
    const text = readLocalChatDisplayText(message) ?? readFinalMessageText(message);
    if (!text) {
      return [];
    }
    const createdAt = readMessageCreatedAtUtc(message);
    return [{
      ...source,
      text,
      ...(createdAt ? { createdAt } : {}),
    }];
  });
}

export function readTuiCheckpointTokenUsage(
  messages: BaseMessage[],
): TuiCheckpointPoint['sessionTokenUsage'] {
  const usage = readMessagesTokenUsage(messages);
  const latestInputTokens = readLatestProviderInputTokens(messages);
  return usage
    ? {
        ...usage,
        ...(latestInputTokens !== null
          ? { latestInputTokens }
          : {}),
        source: 'provider',
        scope: 'session',
      }
    : null;
}

function readTuiCheckpointMessageSource(
  message: BaseMessage,
): TuiCheckpointMessageSource | null {
  const type = message._getType();
  if (type === 'human') return { role: 'user' };
  if (type !== 'ai') return null;
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return { role: 'assistant' };
  if ('lane' in pinpawo || (pinpawo as Record<string, unknown>).synthetic === true) {
    return null;
  }
  if (!('handoffFrom' in pinpawo)) return { role: 'assistant' };
  const runId = (pinpawo as Record<string, unknown>).runId;
  return typeof runId === 'string' && runId.trim()
    ? { role: 'subagent', requestId: runId }
    : null;
}

export function summarizeTuiCheckpointMessages(
  messages: TuiCheckpointMessage[],
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

export class LocalServerTuiSessionService {
  private readonly state: TuiSessionState;
  private readonly saveState: (state: TuiSessionState) => void;
  private readonly checkpointer: TuiSessionCheckpointer;
  private readonly graphService: TuiSessionGraphService;
  private readonly loadContext: typeof loadAgentContext;
  private readonly defaultModelProfileId: string;
  private readonly imageStore: LocalChatImageStore;
  private readonly reportCapabilityDiagnostics = createCapabilityDiagnosticReporter();

  constructor(options: {
    state?: TuiSessionState;
    saveState?: (state: TuiSessionState) => void;
    checkpointer?: TuiSessionCheckpointer;
    graphService?: TuiSessionGraphService;
    loadContext?: typeof loadAgentContext;
    runtimeConfig?: LocalAgentRuntimeConfig;
    sessionStatePath?: string;
    checkpointPath?: string;
    defaultModelProfileId: string;
  }) {
    const runtimeConfig = options.runtimeConfig ?? buildLocalAgentRuntimeConfig();
    const sessionStatePath = options.sessionStatePath ?? runtimeConfig.tuiSessionPath;
    this.defaultModelProfileId = options.defaultModelProfileId;
    this.imageStore = new LocalChatImageStore(
      resolve(runtimeConfig.stateRoot, 'input-images'),
    );
    this.state = options.state ?? loadTuiSessionState(
      this.defaultModelProfileId,
      sessionStatePath,
    );
    this.saveState = options.saveState ?? ((state) => saveTuiSessionState(state, sessionStatePath));
    this.checkpointer = options.checkpointer ?? new FileSaver(
      options.checkpointPath ?? runtimeConfig.tuiCheckpointPath,
    );
    this.graphService = options.graphService ?? new LocalAgentGraphService();
    this.loadContext = options.loadContext ?? loadAgentContext;
  }

  getActiveSession(petId: string) {
    const session = ensureActiveTuiSession(
      this.state,
      petId,
      this.defaultModelProfileId,
    );
    this.save();
    return session;
  }

  getChatThreadId(petId: string) {
    return this.getActiveSession(petId).threadId;
  }

  getActiveSessionId(petId: string) {
    return this.getActiveSession(petId).id;
  }

  getSession(petId: string, sessionId: string) {
    const session = this.state.sessions[sessionId];
    return session?.petId === petId ? session : null;
  }

  createNewSession(petId: string) {
    this.getActiveSession(petId);
    const next = createTuiSession(
      this.state,
      petId,
      this.defaultModelProfileId,
    );
    this.save();
    return next;
  }

  async resetSession(petId: string, options: { deletePrevious?: boolean } = {}) {
    const previous = this.getActiveSession(petId);
    const next = createTuiSession(
      this.state,
      petId,
      this.defaultModelProfileId,
    );
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
    modelProfileIdOverride?: string,
  ) {
    if (!deps.capabilityArtifactStore) {
      throw new Error(
        'TUI chat requires a capability artifact store bound to the current runtime',
      );
    }
    const session = Object.values(this.state.sessions)
      .find((candidate) => candidate.threadId === threadId)
      ?? this.getActiveSession(deps.actorId);
    const modelProfileId = modelProfileIdOverride ?? session.modelProfileId;
    const llmConfig = deps.modelProfiles.resolve(modelProfileId);
    if (
      modelProfileIdOverride === undefined
      && !supportsInputModalities(
        session.requiredInputModalities,
        llmConfig.inputModalities ?? ['text'],
      )
    ) {
      throw new Error(
        `Model profile "${modelProfileId}" is incompatible with session input modalities: missing ${
          missingInputModalities(
            session.requiredInputModalities,
            llmConfig.inputModalities ?? ['text'],
          ).join(', ')
        }`,
      );
    }
    return buildLocalChatAgentInput({
      context: ctx,
      userMessage: '',
      llmConfig: {
        ...llmConfig,
        globalReviewPolicyMode: deps.globalReviewPolicyMode,
      },
      modelInput: {
        imageStore: this.imageStore,
        admitInputModalities: (required) => {
          this.admitSessionInputModalities(
            deps,
            session.id,
            required,
          );
        },
      },
      modelInputCacheKey: session.id,
      toolkits: [...(deps.pluginToolkits ?? []), ...(deps.localToolkits ?? [])],
      toolkitDefinitions: [
        ...(deps.pluginToolkitDefinitions ?? []),
        ...(deps.localToolkitDefinitions ?? []),
      ],
      toolkitRuntimeManager: deps.toolkitRuntimeManager,
      reportCapabilityDiagnostics: this.reportCapabilityDiagnostics,
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

  async createUserMessage(
    deps: LocalServerDeps,
    message: string,
    attachments: readonly AgentLocalAttachment[],
  ) {
    if (attachments.length === 0) {
      return createLocalChatHumanMessage(message);
    }
    const session = this.getActiveSession(deps.actorId);
    const profile = deps.modelProfiles.resolve(session.modelProfileId);
    const admitted = await this.imageStore.admit(attachments, {
      allowImages: (profile.inputModalities ?? ['text']).includes('image'),
    });
    if (admitted.some((attachment) => attachment.source === 'local-image')) {
      this.admitSessionInputModalities(
        deps,
        session.id,
        ['text', 'image'],
      );
    }
    return createAdmittedLocalChatHumanMessage(message, admitted);
  }

  private admitSessionInputModalities(
    deps: LocalServerDeps,
    sessionId: string,
    required: readonly AgentInputModality[],
  ) {
    const session = this.getSession(deps.actorId, sessionId);
    if (!session) {
      throw new Error('session not found while admitting model input');
    }
    const profile = deps.modelProfiles.resolve(session.modelProfileId);
    const supported = profile.inputModalities ?? ['text'];
    if (!supportsInputModalities(required, supported)) {
      throw new Error(
        `Model profile "${profile.modelProfileId ?? session.modelProfileId}" does not support required input modalities: ${
          missingInputModalities(required, supported).join(', ')
        }`,
      );
    }
    const updated = addTuiSessionRequiredInputModalities(
      this.state,
      session.id,
      required,
    );
    if (!updated) {
      throw new Error('session not found while recording model input');
    }
    if (updated !== session) {
      try {
        this.save();
      } catch (error) {
        this.state.sessions[session.id] = session;
        throw error;
      }
    }
  }

  selectModelProfile(
    petId: string,
    sessionId: string,
    modelProfileId: string,
  ) {
    const session = this.state.sessions[sessionId];
    if (!session || session.petId !== petId) {
      throw new Error('session not found');
    }
    if (this.state.activeSessionIds[petId] !== sessionId) {
      throw new Error('model selection requires the active session');
    }
    const updated = updateTuiSessionModelProfile(
      this.state,
      sessionId,
      modelProfileId,
    );
    if (!updated) {
      throw new Error('session not found');
    }
    try {
      this.save();
    } catch (error) {
      this.state.sessions[sessionId] = session;
      throw error;
    }
    return updated;
  }

  async readSessionCheckpointPoint(
    deps: LocalServerDeps,
    session: TuiSessionRecord,
  ): Promise<TuiCheckpointPoint> {
    const ctx = await this.loadContext(deps.actorId);
    let checkpointReaderProfileId = session.modelProfileId;
    try {
      deps.modelProfiles.resolve(checkpointReaderProfileId);
    } catch {
      // Reading a checkpoint does not invoke a model. Build a readable graph
      // with the valid host default so an unavailable session can still be
      // resumed, inspected, and repaired by an explicit model selection.
      checkpointReaderProfileId = deps.modelProfiles.defaultProfileId;
    }
    const setup = this.buildChatSetup(
      deps,
      ctx,
      session.threadId,
      checkpointReaderProfileId,
    );
    const state = await this.graphService.readThreadState(setup);
    const pendingReview = state.pendingHumanReview
      ? {
          sessionId: session.id,
          ...(state.pendingHumanReview.interruptId
            ? { interruptId: state.pendingHumanReview.interruptId }
            : {}),
          review: state.pendingHumanReview.review,
          ...(state.pendingHumanReview.reviews
            ? { reviews: state.pendingHumanReview.reviews }
            : {}),
        }
      : null;
    return {
      sessionId: session.id,
      modelProfileId: session.modelProfileId,
      requiredInputModalities: [...session.requiredInputModalities],
      messages: readTuiCheckpointMessages(state.messages),
      sessionTokenUsage: readTuiCheckpointTokenUsage(state.messages),
      pendingReview,
    };
  }

  async readSessionCheckpointMessages(
    deps: LocalServerDeps,
    session: TuiSessionRecord,
  ) {
    return (await this.readSessionCheckpointPoint(deps, session)).messages;
  }

  updateSessionSummaryFromCheckpoint(
    session: TuiSessionRecord,
    messages: TuiCheckpointMessage[],
  ) {
    updateTuiSessionSummary(this.state, session.id, summarizeTuiCheckpointMessages(messages));
    this.save();
  }

  async refreshActiveSessionSummary(deps: LocalServerDeps) {
    try {
      const session = this.getActiveSession(deps.actorId);
      const messages = await this.readSessionCheckpointMessages(deps, session);
      this.updateSessionSummaryFromCheckpoint(session, messages);
    } catch (err) {
      console.warn('[local-server] failed to refresh TUI session summary:', err instanceof Error ? err.message : err);
    }
  }

  async readActivePendingReview(deps: LocalServerDeps): Promise<ActivePendingReview | null> {
    const session = this.getActiveSession(deps.actorId);
    return (await this.readSessionCheckpointPoint(deps, session)).pendingReview;
  }

  async readActiveCheckpointPoint(deps: LocalServerDeps) {
    const session = this.getActiveSession(deps.actorId);
    const checkpoint = await this.readSessionCheckpointPoint(deps, session);
    updateTuiSessionSummary(
      this.state,
      session.id,
      summarizeTuiCheckpointMessages(checkpoint.messages, session.updatedAt),
    );
    this.save();
    return checkpoint;
  }

  async listSessions(deps: LocalServerDeps) {
    this.getActiveSession(deps.actorId);
    const sessions = listTuiSessions(this.state, deps.actorId);
    const enriched = await Promise.all(sessions.map(async (session) => {
      const messages = await this.readSessionCheckpointMessages(deps, session);
      const summary = summarizeTuiCheckpointMessages(messages, session.updatedAt);
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
    const checkpoint = await this.readSessionCheckpointPoint(deps, candidate);
    const session = resumeTuiSession(this.state, deps.actorId, sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    this.save();
    updateTuiSessionSummary(
      this.state,
      session.id,
      summarizeTuiCheckpointMessages(checkpoint.messages, session.updatedAt),
    );
    this.save();
    return {
      session: {
        ...(this.state.sessions[session.id] ?? session),
        active: true,
      },
      messages: checkpoint.messages,
      sessionTokenUsage: checkpoint.sessionTokenUsage,
      pendingReview: checkpoint.pendingReview,
    };
  }

  private save() {
    this.saveState(this.state);
  }
}
