import type { LocalServerDeps } from './localServerTypes';

export type LocalRuntimeProjection = {
  model: string;
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

export function buildLocalRuntimeProjection(deps: LocalServerDeps): LocalRuntimeProjection {
  const runtimeConfig = deps.runtimeConfig;

  return {
    model: deps.llmConfig.model,
    ...(deps.llmConfig.contextWindowTokens !== undefined
      ? { contextWindow: deps.llmConfig.contextWindowTokens }
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
    llm_model: runtime.model,
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
