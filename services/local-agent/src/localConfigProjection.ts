import {
  GLOBAL_REVIEW_POLICY_MODE,
  type BuiltinGlobalReviewPolicyMode,
} from '@pinpawo/pet-agent';
import {
  DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';
import { readLocalAgentPackageVersion } from './packageVersion';
import type { LocalServerDeps } from './localServerTypes';
import type { ModelInputModality } from './modelProfiles';

export type LocalRuntimeProjection = {
  modelProfileId: string;
  modelProfileLabel: string;
  modelProfileAvailable: boolean;
  modelProfileIssues: readonly string[];
  model?: string;
  inputModalities?: readonly ModelInputModality[];
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  contextWindow?: number;
  workdir: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRoot?: string;
  stateRoot?: string;
  studioConfigPath?: string;
  studioDueRunsPath?: string;
  petsDir?: string;
  studioWikiBaseDir?: string;
};

export function buildLocalRuntimeProjection(
  deps: LocalServerDeps,
  modelProfileId = deps.modelProfiles.defaultProfileId,
): LocalRuntimeProjection {
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
      globalReviewPolicyMode: deps.globalReviewPolicyMode
        ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
      autoAuthorizationSafetyLevel: deps.autoAuthorizationSafetyLevel
        ?? DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
      workdir: runtimeConfig?.workdir ?? deps.workdir,
      ...(runtimeConfig?.workspace ? {
        workspaceId: runtimeConfig.workspace.id,
        workspaceName: runtimeConfig.workspace.name,
        workspaceRoot: runtimeConfig.workspace.rootPath,
      } : {}),
      ...(runtimeConfig ? {
        stateRoot: runtimeConfig.stateRoot,
        studioConfigPath: runtimeConfig.studioConfigPath,
        studioDueRunsPath: runtimeConfig.studioDueRunsPath,
        petsDir: runtimeConfig.petsDir,
        studioWikiBaseDir: runtimeConfig.studioWikiBaseDir,
      } : {}),
    };
  }
  const llmConfig = deps.modelProfiles.resolve(modelProfileId);

  return {
    modelProfileId,
    modelProfileLabel: profile.label,
    modelProfileAvailable: true,
    modelProfileIssues: [],
    model: llmConfig.model,
    inputModalities: llmConfig.inputModalities ?? ['text'],
    globalReviewPolicyMode: deps.globalReviewPolicyMode
      ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    autoAuthorizationSafetyLevel: deps.autoAuthorizationSafetyLevel
      ?? DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
    ...(llmConfig.contextWindowTokens !== undefined
      ? { contextWindow: llmConfig.contextWindowTokens }
      : {}),
    workdir: runtimeConfig?.workdir ?? deps.workdir,
    ...(runtimeConfig?.workspace ? {
      workspaceId: runtimeConfig.workspace.id,
      workspaceName: runtimeConfig.workspace.name,
      workspaceRoot: runtimeConfig.workspace.rootPath,
    } : {}),
    ...(runtimeConfig ? {
      stateRoot: runtimeConfig.stateRoot,
      studioConfigPath: runtimeConfig.studioConfigPath,
      studioDueRunsPath: runtimeConfig.studioDueRunsPath,
      petsDir: runtimeConfig.petsDir,
      studioWikiBaseDir: runtimeConfig.studioWikiBaseDir,
    } : {}),
  };
}

export function buildLocalHttpRuntimeProjection(deps: LocalServerDeps) {
  const runtime = buildLocalRuntimeProjection(deps);
  return {
    local_agent_version: readLocalAgentPackageVersion(),
    model_profile_id: runtime.modelProfileId,
    model_profile_label: runtime.modelProfileLabel,
    model_profile_available: runtime.modelProfileAvailable,
    ...(runtime.model ? { llm_model: runtime.model } : {}),
    ...(runtime.contextWindow !== undefined
      ? { llm_context_window_tokens: runtime.contextWindow }
      : {}),
    workdir: runtime.workdir,
    ...(runtime.workspaceId ? { workspace_id: runtime.workspaceId } : {}),
    ...(runtime.workspaceName ? { workspace_name: runtime.workspaceName } : {}),
    ...(runtime.workspaceRoot ? { workspace_root: runtime.workspaceRoot } : {}),
    ...(runtime.stateRoot ? { state_root: runtime.stateRoot } : {}),
    ...(runtime.studioConfigPath ? { studio_config_path: runtime.studioConfigPath } : {}),
    ...(runtime.studioDueRunsPath ? { studio_due_runs_path: runtime.studioDueRunsPath } : {}),
    ...(runtime.petsDir ? { pets_dir: runtime.petsDir } : {}),
    ...(runtime.studioWikiBaseDir ? { studio_wiki_base_dir: runtime.studioWikiBaseDir } : {}),
  };
}
