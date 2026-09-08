import {
  resolveProviderInputWatermarkTokens,
  type BuiltinGlobalReviewPolicyMode,
} from '@pinpawo/pet-agent';
import {
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';
import { readLocalAgentPackageVersion } from './packageVersion';
import type { LocalServerDeps } from './localServerTypes';
import type { ServerMode } from './serverMode';
import type { ModelInputModality } from './modelProfiles';
import { resolveLlmGenerationReserveTokens } from './llmModelPresets';

export type LocalRuntimeProjection = {
  /** Local-agent projection is always the Chat Host. */
  serverMode: ServerMode;
  modelProfileId: string;
  modelProfileLabel: string;
  modelProfileAvailable: boolean;
  modelProfileIssues: readonly string[];
  model?: string;
  inputModalities?: readonly ModelInputModality[];
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  contextWindow?: number;
  contextCompactionWatermarkTokens?: number;
  workdir: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  stateRoot?: string;
};

export function buildLocalRuntimeProjection(
  deps: LocalServerDeps,
  modelProfileId = deps.modelProfiles.defaultProfileId,
): LocalRuntimeProjection {
  const runtimeConfig = deps.runtimeConfig;
  const profile = deps.modelProfiles.snapshot.profiles[modelProfileId];
  if (!profile) {
    return {
      serverMode: deps.serverMode,
      modelProfileId,
      modelProfileLabel: modelProfileId,
      modelProfileAvailable: false,
      modelProfileIssues:
        deps.modelProfiles.snapshot.unavailableProfiles[modelProfileId]
          ?.map((issue) => issue.message)
        ?? [`Unknown model profile "${modelProfileId}"`],
      globalReviewPolicyMode: deps.globalReviewPolicyMode,
      autoAuthorizationSafetyLevel: deps.autoAuthorizationSafetyLevel,
      workdir: runtimeConfig.workdir,
      ...(runtimeConfig.workspace ? {
        workspaceId: runtimeConfig.workspace.id,
        workspaceName: runtimeConfig.workspace.name,
        workspaceRoot: runtimeConfig.workspace.rootPath,
      } : {}),
      stateRoot: runtimeConfig.stateRoot,
    };
  }
  const llmConfig = deps.modelProfiles.resolve(modelProfileId);
  const contextCompactionWatermarkTokens = resolveProviderInputWatermarkTokens(
    llmConfig.contextWindowTokens,
    resolveLlmGenerationReserveTokens(llmConfig),
  );

  return {
    serverMode: deps.serverMode,
    modelProfileId,
    modelProfileLabel: profile.label,
    modelProfileAvailable: true,
    modelProfileIssues: [],
    model: llmConfig.model,
    inputModalities: llmConfig.inputModalities ?? ['text'],
    globalReviewPolicyMode: deps.globalReviewPolicyMode,
    autoAuthorizationSafetyLevel: deps.autoAuthorizationSafetyLevel,
    ...(llmConfig.contextWindowTokens !== undefined
      ? { contextWindow: llmConfig.contextWindowTokens }
      : {}),
    ...(contextCompactionWatermarkTokens !== null
      ? { contextCompactionWatermarkTokens }
      : {}),
    workdir: runtimeConfig.workdir,
    ...(runtimeConfig.workspace ? {
      workspaceId: runtimeConfig.workspace.id,
      workspaceName: runtimeConfig.workspace.name,
      workspaceRoot: runtimeConfig.workspace.rootPath,
    } : {}),
    stateRoot: runtimeConfig.stateRoot,
  };
}

export function buildLocalHttpRuntimeProjection(deps: LocalServerDeps) {
  const runtime = buildLocalRuntimeProjection(deps);
  return {
    local_agent_version: readLocalAgentPackageVersion(),
    server_mode: runtime.serverMode,
    model_profile_id: runtime.modelProfileId,
    model_profile_label: runtime.modelProfileLabel,
    model_profile_available: runtime.modelProfileAvailable,
    ...(runtime.model ? { llm_model: runtime.model } : {}),
    ...(runtime.contextWindow !== undefined
      ? { llm_context_window_tokens: runtime.contextWindow }
      : {}),
    ...(runtime.contextCompactionWatermarkTokens !== undefined
      ? { context_compaction_watermark_tokens: runtime.contextCompactionWatermarkTokens }
      : {}),
    workdir: runtime.workdir,
    ...(runtime.workspaceId ? { workspace_id: runtime.workspaceId } : {}),
    ...(runtime.workspaceName ? { workspace_name: runtime.workspaceName } : {}),
    ...(runtime.workspaceRoot ? { workspace_root: runtime.workspaceRoot } : {}),
    ...(runtime.stateRoot ? { state_root: runtime.stateRoot } : {}),
  };
}
