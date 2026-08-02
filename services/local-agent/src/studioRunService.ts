import {
  buildStudioRunIdentity,
  type StudioRunIdentity,
} from '@pinpawo/pet-agent';
import type {
  StudioTurnEvent,
  StudioTurnResult,
} from '@pinpawo/pet-agent';
import { getLocalServerWorkdir, type LocalServerDeps } from './localServerTypes';
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
};

export type StudioRunServiceResult = {
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  workdir: string;
  turn: StudioTurnResult;
};

export class StudioRunService {
  private readonly buildStudio: BuildStudioForTurn;

  constructor(options: { buildStudio?: BuildStudioForTurn } = {}) {
    this.buildStudio = options.buildStudio ?? buildStudioForTurn;
  }

  async run(request: StudioRunServiceRequest): Promise<StudioRunServiceResult> {
    const { deps, runId, userRequest } = request;
    const effectiveWorkdir = getLocalServerWorkdir(deps);
    const identity: StudioRunIdentity = buildStudioRunIdentity({
      runId,
      conversationId: request.conversationId,
    });
    const { orchestrator } = await this.buildStudio(buildStudioInputFromDeps(request));
    const accepted = await orchestrator.submitRequest({
      userRequest,
      conversationId: identity.conversationId,
      turnId: runId,
      signal: request.signal,
      onTurnEvent: request.onProgress,
    });
    const turn = await orchestrator.waitForRun(accepted.runId);

    return {
      runId: identity.runId,
      conversationId: identity.conversationId,
      idempotencyKey: identity.idempotencyKey,
      workdir: effectiveWorkdir,
      turn,
    };
  }
}

function buildStudioInputFromDeps(request: StudioRunServiceRequest): BuildStudioInput {
  const { deps } = request;
  return {
    modelProfiles: deps.modelProfiles,
    capabilities: [
      ...(deps.localCapabilities ?? []),
      ...(deps.userCapabilities ?? []).map((u) => u.capability),
    ],
    toolkits: [...(deps.pluginToolkits ?? []), ...(deps.localToolkits ?? [])],
    toolkitRuntimeManager: deps.toolkitRuntimeManager,
    ownerUserId: request.ownerUserId ?? null,
    bridge: request.bridge,
    workdir: getLocalServerWorkdir(deps),
    ...(deps.runtimeConfig ? {
      studioConfigPath: deps.runtimeConfig.studioConfigPath,
      petsDir: deps.runtimeConfig.petsDir,
      wikiBaseDir: deps.runtimeConfig.studioWikiBaseDir,
    } : {}),
  };
}
