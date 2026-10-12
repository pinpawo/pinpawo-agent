import {
  resolveProviderInputWatermarkTokens,
} from '@pinpawo/pet-agent';
import {
  type ToolAuthorizationSafetyLevel,
  type ToolAuthorizationMode,
} from '@pinpawo/agent-contracts';
import type { RuntimeProjectionDeps } from '../serverTypes';
import type { ModelInputModality } from './modelProfiles';
import { resolveLlmGenerationReserveTokens } from './llmModelPresets';

export type RuntimeProjection = {
  /** The Host projection is always the Chat Host. */
  modelProfileId: string;
  modelProfileLabel: string;
  modelProfileAvailable: boolean;
  modelProfileIssues: readonly string[];
  model?: string;
  inputModalities?: readonly ModelInputModality[];
  toolAuthorizationMode: ToolAuthorizationMode;
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
  deps: RuntimeProjectionDeps,
  modelProfileId = deps.modelProfiles.defaultProfileId,
): RuntimeProjection {
  const runtimeConfig = deps.runtimeConfig;
  const profile = deps.modelProfiles.snapshot.profiles[modelProfileId];
  if (!profile) {
    return {
      modelProfileId,
      modelProfileLabel: modelProfileId,
      modelProfileAvailable: false,
      modelProfileIssues:
        deps.modelProfiles.snapshot.unavailableProfiles[modelProfileId]
          ?.map((issue) => issue.message)
        ?? [`Unknown model profile "${modelProfileId}"`],
      toolAuthorizationMode: deps.toolAuthorizationMode,
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
    modelProfileId,
    modelProfileLabel: profile.label,
    modelProfileAvailable: true,
    modelProfileIssues: [],
    model: llmConfig.model,
    inputModalities: llmConfig.inputModalities ?? ['text'],
    toolAuthorizationMode: deps.toolAuthorizationMode,
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
