import {
  buildStudioRunIdentity,
  type StudioRunIdentity,
} from '@pinpawo/pet-agent';
import type {
  StudioTurnEvent,
  StudioTurnResult,
  SubagentToolEventHandler,
} from '@pinpawo/pet-agent';
import type { LocalServerDeps } from './localServerTypes';
import {
  buildStudioForTurn,
  type BuildStudioInput,
  type BuildStudioResult,
  type StudioBridgeContext,
} from './studio/studioRuntime';

export type BuildStudioForTurn = (input: BuildStudioInput) => Promise<BuildStudioResult>;

export type StudioRunServiceRequest = {
  deps: LocalServerDeps;
  runId: string;
  userRequest: string;
  conversationId?: string;
  signal?: AbortSignal;
  ownerUserId?: string | null;
  bridge: StudioBridgeContext;
  onProgress?: (event: StudioTurnEvent) => void;
  onToolEvent?: SubagentToolEventHandler;
};

export type StudioRunServiceResult = {
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  turn: StudioTurnResult;
};

export class StudioRunService {
  private readonly buildStudio: BuildStudioForTurn;

  constructor(options: { buildStudio?: BuildStudioForTurn } = {}) {
    this.buildStudio = options.buildStudio ?? buildStudioForTurn;
  }

  async run(request: StudioRunServiceRequest): Promise<StudioRunServiceResult> {
    const { deps, runId, userRequest } = request;
    const identity: StudioRunIdentity = buildStudioRunIdentity({
      runId,
      conversationId: request.conversationId,
    });
    const { orchestrator } = await this.buildStudio(buildStudioInputFromDeps(request));
    const turn = await orchestrator.invoke({
      userRequest,
      conversationId: identity.conversationId,
      turnId: runId,
      signal: request.signal,
      onTurnEvent: request.onProgress,
      onToolEvent: request.onToolEvent,
    });

    return {
      runId: identity.runId,
      conversationId: identity.conversationId,
      idempotencyKey: identity.idempotencyKey,
      turn,
    };
  }
}

function buildStudioInputFromDeps(request: StudioRunServiceRequest): BuildStudioInput {
  const { deps } = request;
  return {
    llmConfig: deps.llmConfig,
    capabilities: [
      ...(deps.localCapabilities ?? []),
      ...(deps.userCapabilities ?? []).map((u) => u.capability),
    ],
    toolkits: [...(deps.pluginToolkits ?? []), ...(deps.localToolkits ?? [])],
    ownerUserId: request.ownerUserId ?? null,
    bridge: request.bridge,
    workdir: deps.runtimeConfig?.workdir ?? deps.workdir,
    ...(deps.runtimeConfig ? {
      studioConfigPath: deps.runtimeConfig.studioConfigPath,
      petsDir: deps.runtimeConfig.petsDir,
      wikiBaseDir: deps.runtimeConfig.studioWikiBaseDir,
    } : {}),
  };
}
