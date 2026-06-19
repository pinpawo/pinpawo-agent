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
import { createWsHumanReviewer } from './studio/studioBridge';

export type BuildStudioForTurn = (input: BuildStudioInput) => Promise<BuildStudioResult>;

export type StudioRuntimeHostRunInput = Omit<StudioRunServiceRequest, 'deps'>;

export type StudioRuntimeHost = BuildStudioResult & {
  workdir: string;
  run: (request: StudioRuntimeHostRunInput) => Promise<StudioRunServiceResult>;
};

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
  workdir: string;
  turn: StudioTurnResult;
};

export class StudioRunService {
  private readonly buildStudio: BuildStudioForTurn;
  private readonly runtimeHost?: StudioRuntimeHost;

  constructor(options: {
    buildStudio?: BuildStudioForTurn;
    runtimeHost?: StudioRuntimeHost;
  } = {}) {
    this.buildStudio = options.buildStudio ?? buildStudioForTurn;
    this.runtimeHost = options.runtimeHost;
  }

  async run(request: StudioRunServiceRequest): Promise<StudioRunServiceResult> {
    const { deps, runId, userRequest } = request;
    if (this.runtimeHost) {
      return await this.runtimeHost.run({
        runId,
        userRequest,
        conversationId: request.conversationId,
        signal: request.signal,
        ownerUserId: request.ownerUserId,
        bridge: request.bridge,
        onProgress: request.onProgress,
        onToolEvent: request.onToolEvent,
      });
    }

    const effectiveWorkdir = deps.runtimeConfig?.workdir ?? deps.workdir;
    const identity: StudioRunIdentity = buildStudioRunIdentity({
      runId,
      conversationId: request.conversationId,
    });
    const { orchestrator } = await this.buildStudio(
      buildStudioInputFromDeps(deps, request.ownerUserId ?? null),
    );
    const accepted = await orchestrator.submitRequest({
      userRequest,
      conversationId: identity.conversationId,
      turnId: runId,
      signal: request.signal,
      onTurnEvent: request.onProgress,
      onToolEvent: request.onToolEvent,
      humanReviewerForPet: (petId) => createWsHumanReviewer({
        send: request.bridge.send,
        requestId: request.bridge.requestId,
        petId,
        slot: request.bridge.slot,
      }),
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

export async function createStudioRuntimeHost(input: BuildStudioInput): Promise<StudioRuntimeHost> {
  const built = await buildStudioForTurn(input);
  const workdir = built.workdir;
  return {
    ...built,
    workdir,
    run: async (request) => runWithOrchestrator({
      orchestrator: built.orchestrator,
      workdir,
      request,
    }),
  };
}

async function runWithOrchestrator(params: {
  orchestrator: BuildStudioResult['orchestrator'];
  workdir: string;
  request: StudioRuntimeHostRunInput;
}): Promise<StudioRunServiceResult> {
  const { request } = params;
  const identity: StudioRunIdentity = buildStudioRunIdentity({
    runId: request.runId,
    conversationId: request.conversationId,
  });
  const accepted = await params.orchestrator.submitRequest({
    userRequest: request.userRequest,
    conversationId: identity.conversationId,
    turnId: request.runId,
    signal: request.signal,
    onTurnEvent: request.onProgress,
    onToolEvent: request.onToolEvent,
    humanReviewerForPet: (petId) => createWsHumanReviewer({
      send: request.bridge.send,
      requestId: request.bridge.requestId,
      petId,
      slot: request.bridge.slot,
    }),
  });
  const turn = await params.orchestrator.waitForRun(accepted.runId);
  return {
    runId: identity.runId,
    conversationId: identity.conversationId,
    idempotencyKey: identity.idempotencyKey,
    workdir: params.workdir,
    turn,
  };
}

export function buildStudioInputFromDeps(
  deps: LocalServerDeps,
  ownerUserId: string | null = null,
): BuildStudioInput {
  return {
    llmConfig: deps.llmConfig,
    capabilities: [
      ...(deps.localCapabilities ?? []),
      ...(deps.userCapabilities ?? []).map((u) => u.capability),
    ],
    toolkits: [...(deps.pluginToolkits ?? []), ...(deps.localToolkits ?? [])],
    ownerUserId,
    workdir: deps.runtimeConfig?.workdir ?? deps.workdir,
    ...(deps.runtimeConfig ? {
      studioConfigPath: deps.runtimeConfig.studioConfigPath,
      petsDir: deps.runtimeConfig.petsDir,
      wikiBaseDir: deps.runtimeConfig.studioWikiBaseDir,
    } : {}),
  };
}
