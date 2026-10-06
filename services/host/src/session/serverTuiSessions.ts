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
import { createCapabilityDiagnosticReporter } from '../agent/agentRegistryPreparation';
import {
  buildChatSetup,
} from '../agent/buildChatSetup';
import { HostGraphService } from '../agent/agentGraphService';
import { readFinalMessageText } from '../agent/agentStreamEvents';
import { loadAgentContext } from '../contextLoader';
import { FileSaver } from '../fileSaver';
import type { ServerDeps } from '../serverTypes';
import {
  createAdmittedLocalChatHumanMessage,
  createLocalChatHumanMessage,
  readLocalChatDisplayText,
} from '../agent/chatMessageInput';
import { ImageAttachmentAdmission } from '../agent/attachmentAdmission';
import type { HostRuntimeConfig } from '../config/runtimeConfig';
import { type TuiSessionRecord } from './tuiSessionRegistry';
import type { SessionRegistryPort } from '../persistence/contracts';


import {
  readTuiCheckpointInputModalities,
  readTuiCheckpointMessages,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiCheckpointMessage,
} from '../conversation/transcriptProjection';

// Transcript projection belongs to Conversation; re-exported here so existing
// importers of this module keep working while the domains settle.
export {
  readTuiCheckpointMessages,
  readTuiCheckpointInputModalities,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiCheckpointMessage,
} from '../conversation/transcriptProjection';

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
type TuiSessionGraphService = Pick<HostGraphService, 'readThreadState'>;


export class ServerTuiSessionService {
  private readonly registry: SessionRegistryPort;
  private readonly checkpointer: TuiSessionCheckpointer;
  private readonly graphService: TuiSessionGraphService;
  private readonly loadContext: typeof loadAgentContext;
  private readonly imageAdmission = new ImageAttachmentAdmission();
  private readonly reportCapabilityDiagnostics = createCapabilityDiagnosticReporter();

  constructor(options: {
    registry: SessionRegistryPort;
    checkpointer?: TuiSessionCheckpointer;
    graphService?: TuiSessionGraphService;
    loadContext?: typeof loadAgentContext;
    runtimeConfig: HostRuntimeConfig;
    checkpointPath?: string;
  }) {
    const runtimeConfig = options.runtimeConfig;
    this.registry = options.registry;
    this.checkpointer = options.checkpointer ?? new FileSaver(
      options.checkpointPath ?? runtimeConfig.tuiCheckpointPath,
    );
    this.graphService = options.graphService ?? new HostGraphService();
    this.loadContext = options.loadContext ?? loadAgentContext;
  }

  getActiveSession(petId: string) { return this.registry.ensureActive(petId); }
  async hasActiveSession(petId: string): Promise<boolean> { return !!await this.registry.active(petId); }
  async adoptInitialThread(petId: string, threadId: string) {
    return await this.registry.active(petId) ?? this.registry.create(petId, threadId);
  }
  async getChatThreadId(petId: string) { return (await this.getActiveSession(petId)).threadId; }
  async getActiveSessionId(petId: string) { return (await this.getActiveSession(petId)).id; }
  async getSession(petId: string, sessionId: string) {
    const session = await this.registry.read(sessionId);
    return session?.petId === petId ? session : null;
  }
  ensureDispatchSession(petId: string, sessionId: string, create = false) {
    return this.registry.register(petId, sessionId, create);
  }

  async buildSessionSetup(deps: ServerDeps, ctx: Awaited<ReturnType<typeof loadAgentContext>>, sessionId: string) {
    const session = await this.getSession(deps.petId, sessionId);
    if (!session) throw new Error('Target session does not exist or belongs to another Pet.');
    return this.buildChatSetup(deps, ctx, session.threadId);
  }

  createNewSession(petId: string) { return this.registry.create(petId); }
  async resetSession(petId: string, options: { deletePrevious?: boolean } = {}) {
    const previous = await this.getActiveSession(petId);
    if (options.deletePrevious) {
      // Remove registration first; unresolved invocations fail closed before
      // runtime deletion can erase their thread.
      await this.registry.remove(previous.id);
      await this.checkpointer.deleteThread(previous.threadId);
    }
    return this.registry.create(petId);
  }

  /**
   * Resolve which session an execution runs in, then hand assembly to agent.
   *
   * Session's part is identity only — thread, selected model, start time.
   * Assembling the graph belongs to agent, which is why the work below lives
   * in agent/buildChatSetup rather than here.
   */
  async buildChatSetup(
    deps: ServerDeps,
    ctx: Awaited<ReturnType<typeof loadAgentContext>>,
    threadId?: string,
    modelProfileIdOverride?: string,
  ) {
    threadId ??= await this.getChatThreadId(deps.petId);
    const session = (await this.registry.list(deps.petId))
      .find((candidate) => candidate.threadId === threadId)
      ?? await this.getActiveSession(deps.petId);
    return buildChatSetup({
      deps,
      context: ctx,
      session: {
        threadId,
        modelProfileId: modelProfileIdOverride ?? session.modelProfileId,
        startedAt: session.createdAt,
      },
      checkpointer: this.checkpointer,
      reportCapabilityDiagnostics: this.reportCapabilityDiagnostics,
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
    const session = await this.getActiveSession(deps.petId);
    const profile = deps.modelProfiles.resolve(session.modelProfileId);
    const admitted = await this.imageAdmission.admit(attachments, {
      allowImages: (profile.inputModalities ?? ['text']).includes('image'),
    });
    // Nothing is recorded here: the admitted image blocks live in the message
    // itself, so the session's modalities are read back off the transcript.
    return createAdmittedLocalChatHumanMessage(message, admitted);
  }

  async selectModelProfile(
    petId: string,
    sessionId: string,
    modelProfileId: string,
  ) {
    const session = await this.getSession(petId, sessionId);
    if (!session) throw new Error('session not found');
    if ((await this.registry.active(petId))?.id !== sessionId) throw new Error('model selection requires the active session');
    return this.registry.updateProfile(sessionId, modelProfileId);
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
    const setup = await this.buildChatSetup(
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
    return this.registry.updateSummary(session.id, summarizeTuiCheckpointMessages(messages));
  }

  async refreshActiveSessionSummary(deps: ServerDeps) {
    try {
      const session = await this.getActiveSession(deps.petId);
      const messages = await this.readSessionCheckpointMessages(deps, session);
      await this.updateSessionSummaryFromCheckpoint(session, messages);
    } catch (err) {
      console.warn('[local-server] failed to refresh TUI session summary:', err instanceof Error ? err.message : err);
    }
  }

  async readActivePendingInterrupt(deps: ServerDeps): Promise<ActivePendingInterrupt | null> {
    const session = await this.getActiveSession(deps.petId);
    return (await this.readSessionCheckpointPoint(deps, session)).pendingInterrupt;
  }

  async readActiveCheckpointPoint(deps: ServerDeps) {
    const session = await this.getActiveSession(deps.petId);
    const checkpoint = await this.readSessionCheckpointPoint(deps, session);
    return checkpoint;
  }

  async listSessions(deps: ServerDeps) {
    const active = await this.getActiveSession(deps.petId);
    const sessions = (await this.registry.list(deps.petId)).map(s => ({ ...s, active: s.id === active.id }));
    const enriched = await Promise.all(sessions.map(async (session) => {
      const messages = await this.readSessionCheckpointMessages(deps, session);
      const summary = summarizeTuiCheckpointMessages(messages, session.updatedAt);
      return {
        ...session,
        active: session.active,
        messageCount: summary.messageCount,
        title: summary.title,
        updatedAt: summary.updatedAt,
      };
    }));
    return enriched.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async resumeSession(deps: ServerDeps, sessionId: string) {
    const candidate = await this.registry.read(sessionId);
    if (!candidate || candidate.petId !== deps.petId) {
      throw new Error('session not found');
    }
    const checkpoint = await this.readSessionCheckpointPoint(deps, candidate);
    const session = await this.registry.select(deps.petId, sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    await this.registry.updateSummary(
      session.id,
      summarizeTuiCheckpointMessages(checkpoint.messages, session.updatedAt),
    );
    return {
      session: {
        ...(await this.registry.read(session.id) ?? session),
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

}
