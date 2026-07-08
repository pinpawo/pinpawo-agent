import { existsSync } from 'node:fs';
import { getLocalServerRuntimeConfig, type LocalServerDeps } from './localServerTypes';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import { DEFAULT_STUDIO_CONFIG_PATH } from './studio/studioConfig';
import type { TuiCoreRuntimeSnapshot } from './tui/contracts/tuiCoreContract';

function resolveStudioConfigPaths(runtimeConfig: LocalAgentRuntimeConfig) {
  const preferredPath = runtimeConfig.studioConfigPath;
  const legacyAvailable = preferredPath !== DEFAULT_STUDIO_CONFIG_PATH
    && existsSync(DEFAULT_STUDIO_CONFIG_PATH);
  const preferredAvailable = existsSync(preferredPath);
  return {
    source: preferredAvailable
      ? 'workdir'
      : legacyAvailable
        ? 'legacy_home'
        : 'missing',
    activePath: preferredAvailable
      ? preferredPath
      : legacyAvailable
        ? DEFAULT_STUDIO_CONFIG_PATH
        : preferredPath,
    legacyPath: DEFAULT_STUDIO_CONFIG_PATH,
  } as const;
}

export function serializeLocalConfigForHttp(deps: LocalServerDeps) {
  const runtimeConfig = getLocalServerRuntimeConfig(deps);
  const studioConfig = resolveStudioConfigPaths(runtimeConfig);
  return {
    llm_model: deps.llmConfig.model,
    llm_context_window_tokens: deps.llmConfig.contextWindowTokens,
    workdir: runtimeConfig.workdir,
    state_root: runtimeConfig.stateRoot,
    studio_config_path: runtimeConfig.studioConfigPath,
    studio_due_runs_path: runtimeConfig.studioDueRunsPath,
    pets_dir: runtimeConfig.petsDir,
    studio_wiki_base_dir: runtimeConfig.studioWikiBaseDir,
    studio_config_source: studioConfig.source,
    studio_config_active_path: studioConfig.activePath,
    legacy_studio_config_path: studioConfig.legacyPath,
  };
}

export function buildTuiCoreRuntimeSnapshot(deps: LocalServerDeps): TuiCoreRuntimeSnapshot {
  const runtimeConfig = getLocalServerRuntimeConfig(deps);
  const studioConfig = resolveStudioConfigPaths(runtimeConfig);
  return {
    model: deps.llmConfig.model,
    ...(deps.llmConfig.contextWindowTokens !== undefined
      ? { contextWindow: deps.llmConfig.contextWindowTokens }
      : {}),
    cwd: runtimeConfig.workdir,
    stateRoot: runtimeConfig.stateRoot,
    studioConfigPath: runtimeConfig.studioConfigPath,
    studioDueRunsPath: runtimeConfig.studioDueRunsPath,
    petsDir: runtimeConfig.petsDir,
    studioWikiBaseDir: runtimeConfig.studioWikiBaseDir,
    studioConfigSource: studioConfig.source,
    studioConfigActivePath: studioConfig.activePath,
    legacyStudioConfigPath: studioConfig.legacyPath,
  };
}
