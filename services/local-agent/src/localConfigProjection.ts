import { existsSync } from 'node:fs';
import type { LocalServerDeps } from './localServerTypes';
import { DEFAULT_STUDIO_CONFIG_PATH } from './studio/studioConfig';

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
  studioConfigSource: 'workdir' | 'legacy_home' | 'missing';
  studioConfigActivePath: string;
  legacyStudioConfigPath: string;
};

export type LocalRuntimeProjectionOptions = {
  legacyStudioConfigPath?: string;
};

export function buildLocalRuntimeProjection(
  deps: LocalServerDeps,
  options: LocalRuntimeProjectionOptions = {},
): LocalRuntimeProjection {
  const runtimeConfig = deps.runtimeConfig;
  const legacyStudioConfigPath = options.legacyStudioConfigPath ?? DEFAULT_STUDIO_CONFIG_PATH;
  const preferredPath = runtimeConfig?.studioConfigPath ?? legacyStudioConfigPath;
  const preferredAvailable = existsSync(preferredPath);
  const legacyAvailable = preferredPath !== legacyStudioConfigPath
    && existsSync(legacyStudioConfigPath);

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
    studioConfigSource: preferredAvailable
      ? (runtimeConfig ? 'workdir' : 'legacy_home')
      : legacyAvailable
        ? 'legacy_home'
        : 'missing',
    studioConfigActivePath: preferredAvailable
      ? preferredPath
      : legacyAvailable
        ? legacyStudioConfigPath
        : preferredPath,
    legacyStudioConfigPath,
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
    studio_config_source: runtime.studioConfigSource,
    studio_config_active_path: runtime.studioConfigActivePath,
    legacy_studio_config_path: runtime.legacyStudioConfigPath,
  };
}
