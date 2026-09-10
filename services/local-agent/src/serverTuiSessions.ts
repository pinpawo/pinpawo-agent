import { resolve } from 'node:path';
import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type {
  AgentInputModality,
  AgentLocalAttachment,
  AgentPlan,
} from '@pinpawo/agent-session';
import {
  readAgentMessageCreatedAt,
  readCapabilityExecutions,
  readLatestProviderInputTokens,
  readMessagesTokenUsage,
  mainConversationMessages,
  type PendingInterrupt,
  type ReviewSpec,
  type TokenUsageSnapshot,
} from '@pinpawo/pet-agent';
import { buildLocalChatAgentInput } from './agentChannel';
import { createCapabilityDiagnosticReporter } from './agentRegistryPreparation';
import { LocalAgentGraphService } from './agentGraphService';
import { readFinalMessageText } from './agentStreamEvents';
import { loadAgentContext } from './contextLoader';
import { FileSaver } from './fileSaver';
import {
  getLocalServerToolkitInventory,
  type ServerDeps,
} from './serverTypes';
import {
  createAdmittedLocalChatHumanMessage,
  createLocalChatHumanMessage,
  readLocalChatDisplayText,
} from './agent/chatMessageInput';
import { ImageAttachmentAdmission } from './agent/attachmentAdmission';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import {
  createTuiSession,
  createTuiSessionForThread,
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


import {
  readTuiCheckpointInputModalities,
  readTuiCheckpointMessages,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiCheckpointMessage,
} from './conversation/transcriptProjection';

// Transcript projection belongs to Conversation; re-exported here so existing
// importers of this module keep working while the domains settle.
export {
  readTuiCheckpointMessages,
  readTuiCheckpointInputModalities,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiCheckpointMessage,
} from './conversation/transcriptProjection';

export type ActivePendingInterrupt = PendingInterrupt & {
  sessionId: string;
};

export type TuiCheckpointPoint = {
  sessionId: string;
  modelProfileId: string;
  requiredInputModalities: AgentInputModality[];
  messages: TuiCheckpointMessage[];
  sessionTokenUsage: (TokenUsageSnapshot & { scope: 'session' }) | null;
  pendingInterrupt: ActivePendingInterrupt | null;
  currentPlan: AgentPlan | null;
};

export type TuiSessionCheckpointer = BaseCheckpointSaver & Pick<FileSaver, 'deleteThread'>;
type TuiSessionGraphService = Pick<LocalAgentGraphService, 'readThreadState'>;


export class ServerTuiSessionService {
  private readonly state: TuiSessionState;
  private readonly saveState: (state: TuiSessionState) => void;
  private readonly checkpointer: TuiSessionCheckpointer;
  private readonly graphService: TuiSessionGraphService;
  private readonly loadContext: typeof loadAgentContext;
  private readonly defaultModelProfileId: string;
  private readonly imageAdmission = new ImageAttachmentAdmission();
  private readonly reportCapabilityDiagnostics = createCapabilityDiagnosticReporter();

  constructor(options: {
    state?: TuiSessionState;
    saveState?: (state: TuiSessionState) => void;
    checkpointer?: TuiSessionCheckpointer;
    graphService?: TuiSessionGraphService;
    loadContext?: typeof loadAgentContext;
    runtimeConfig: LocalAgentRuntimeConfig;
    sessionStatePath?: string;
    checkpointPath?: string;
    defaultModelProfileId: string;
  }) {
    const runtimeConfig = options.runtimeConfig;
    const sessionStatePath = options.sessionStatePath ?? runtimeConfig.tuiSessionPath;
    this.defaultModelProfileId = options.defaultModelProfileId;
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

  hasActiveSession(petId: string): boolean {
    const activeId = this.state.activeSessionIds[petId];
    return Boolean(activeId && this.state.sessions[activeId]?.petId === petId);
  }

  adoptInitialThread(petId: string, threadId: string) {
    if (this.hasActiveSession(petId)) {
      return this.getActiveSession(petId);
    }
    const session = createTuiSessionForThread(
      this.state,
      petId,
      this.defaultModelProfileId,
      threadId,
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
    deps: ServerDeps,
    ctx: Awaited<ReturnType<typeof loadAgentContext>>,
    threadId = this.getChatThreadId(deps.petId),
    modelProfileIdOverride?: string,
  ) {
    if (!deps.capabilityArtifactStore) {
      throw new Error(
        'TUI chat requires a capability artifact store bound to the current runtime',
      );
    }
    const session = Object.values(this.state.sessions)
      .find((candidate) => candidate.threadId === threadId)
      ?? this.getActiveSession(deps.petId);
    const modelProfileId = modelProfileIdOverride ?? session.modelProfileId;
    const llmConfig = deps.modelProfiles.resolve(modelProfileId);
    // Compatibility is enforced where the transcript is readable: model
    // selection checks the checkpoint, and image attachments are refused at
    // admission. Building the graph is synchronous, so it does not re-check
    // against a stored copy that could disagree with the transcript.
    const toolkitInventory = getLocalServerToolkitInventory(deps);
    return buildLocalChatAgentInput({
      context: ctx,
      userMessage: '',
      llmConfig,
      hostConfig: deps,
      toolkits: [...toolkitInventory.effectiveToolkits],
      toolkitInventoryEntries: toolkitInventory.entries,
      toolkitRuntimeManager: deps.toolkitRuntimeManager,
      reportCapabilityDiagnostics: this.reportCapabilityDiagnostics,
      capabilities: deps.capabilityCatalog.getSnapshot().capabilities,
      ...(deps.defaultCapabilityName !== undefined
        ? { defaultCapabilityName: deps.defaultCapabilityName }
        : {}),
      ...(deps.petDocument ? { petDocument: deps.petDocument } : {}),
      threadId,
      interfaceKind: 'tui',
      checkpoint: this.checkpointer,
      capabilityArtifactStore: deps.capabilityArtifactStore,
      sessionStartedAt: session.createdAt,
    });
  }

  async createUserMessage(
    deps: ServerDeps,
    message: string,
    attachments: readonly AgentLocalAttachment[],
  ) {
    if (attachments.length === 0) {
      return createLocalChatHumanMessage(message);
    }
    const session = this.getActiveSession(deps.petId);
    const profile = deps.modelProfiles.resolve(session.modelProfileId);
    const admitted = await this.imageAdmission.admit(attachments, {
      allowImages: (profile.inputModalities ?? ['text']).includes('image'),
    });
    // Nothing is recorded here: the admitted image blocks live in the message
    // itself, so the session's modalities are read back off the transcript.
    return createAdmittedLocalChatHumanMessage(message, admitted);
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
    deps: ServerDeps,
    session: TuiSessionRecord,
  ): Promise<TuiCheckpointPoint> {
    const ctx = await this.loadContext(deps.petId);
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
    const pendingInterrupt = state.pendingInterrupt
      ? { sessionId: session.id, ...state.pendingInterrupt }
      : null;
    return {
      sessionId: session.id,
      modelProfileId: session.modelProfileId,
      requiredInputModalities: readTuiCheckpointInputModalities(state.messages),
      messages: readTuiCheckpointMessages(state.messages),
      sessionTokenUsage: readTuiCheckpointTokenUsage(state.messages),
      pendingInterrupt,
      currentPlan: state.currentPlan,
    };
  }

  async readSessionCheckpointMessages(
    deps: ServerDeps,
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

  async refreshActiveSessionSummary(deps: ServerDeps) {
    try {
      const session = this.getActiveSession(deps.petId);
      const messages = await this.readSessionCheckpointMessages(deps, session);
      this.updateSessionSummaryFromCheckpoint(session, messages);
    } catch (err) {
      console.warn('[local-server] failed to refresh TUI session summary:', err instanceof Error ? err.message : err);
    }
  }

  async readActivePendingInterrupt(deps: ServerDeps): Promise<ActivePendingInterrupt | null> {
    const session = this.getActiveSession(deps.petId);
    return (await this.readSessionCheckpointPoint(deps, session)).pendingInterrupt;
  }

  async readActiveCheckpointPoint(deps: ServerDeps) {
    const session = this.getActiveSession(deps.petId);
    const checkpoint = await this.readSessionCheckpointPoint(deps, session);
    updateTuiSessionSummary(
      this.state,
      session.id,
      summarizeTuiCheckpointMessages(checkpoint.messages, session.updatedAt),
    );
    this.save();
    return checkpoint;
  }

  async listSessions(deps: ServerDeps) {
    this.getActiveSession(deps.petId);
    const sessions = listTuiSessions(this.state, deps.petId);
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

  async resumeSession(deps: ServerDeps, sessionId: string) {
    const candidate = this.state.sessions[sessionId];
    if (!candidate || candidate.petId !== deps.petId) {
      throw new Error('session not found');
    }
    const checkpoint = await this.readSessionCheckpointPoint(deps, candidate);
    const session = resumeTuiSession(this.state, deps.petId, sessionId);
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
        // Report what the restored transcript actually holds, not the value
        // the record was persisted with.
        requiredInputModalities: checkpoint.requiredInputModalities,
        active: true,
      },
      messages: checkpoint.messages,
      sessionTokenUsage: checkpoint.sessionTokenUsage,
      pendingInterrupt: checkpoint.pendingInterrupt,
      currentPlan: checkpoint.currentPlan,
    };
  }

  private save() {
    this.saveState(this.state);
  }
}
