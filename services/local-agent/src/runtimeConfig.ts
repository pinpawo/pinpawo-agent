import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { loadStoredConfig, type StoredConfig } from './storage';

export type LocalAgentWorkspaceConfig = Readonly<{
  id: string;
  name: string;
  rootPath: string;
}>;

export type LocalAgentRuntimeConfig = Readonly<{
  workdir: string;
  workspace?: LocalAgentWorkspaceConfig;
  stateRoot: string;
  studioConfigPath: string;
  studioDueRunsPath: string;
  petsDir: string;
  studioWikiBaseDir: string;
  checkpointPath: string;
  tuiCheckpointPath: string;
  tuiSessionPath: string;
  capabilityArtifactRoot: string;
}>;

function freezeRuntimeConfig(input: LocalAgentRuntimeConfig): LocalAgentRuntimeConfig {
  return Object.freeze({
    ...input,
    ...(input.workspace ? { workspace: Object.freeze({ ...input.workspace }) } : {}),
  });
}

export function resolveUserDir(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return homedir();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

export function resolveDefaultWorkdir(
  env: Record<string, string | undefined> = process.env,
  stored: Pick<StoredConfig, 'workdir'> = loadStoredConfig(),
): string {
  return env.PINPAWO_WORKDIR?.trim()
    || (typeof stored.workdir === 'string' ? stored.workdir.trim() : '')
    || process.cwd()
    || homedir();
}

export function buildLocalAgentRuntimeConfig(workdir = resolveDefaultWorkdir()): LocalAgentRuntimeConfig {
  const resolvedWorkdir = resolveUserDir(workdir || homedir());
  const stateRoot = resolve(resolvedWorkdir, '.pinpawo');
  return freezeRuntimeConfig({
    workdir: resolvedWorkdir,
    stateRoot,
    studioConfigPath: resolve(stateRoot, 'studio.json'),
    studioDueRunsPath: resolve(stateRoot, 'studio-due-runs.json'),
    petsDir: resolve(stateRoot, 'pets'),
    studioWikiBaseDir: resolve(stateRoot, 'studio-wiki'),
    checkpointPath: resolve(stateRoot, 'checkpoints.json'),
    tuiCheckpointPath: resolve(stateRoot, 'checkpoints-tui.json'),
    tuiSessionPath: resolve(stateRoot, 'tui-sessions.json'),
    capabilityArtifactRoot: resolve(stateRoot, 'capability-artifacts'),
  });
}

export type WorkspaceRuntimeConfigOptions = {
  workdir?: string;
  workspaceId?: string;
  workspaceName?: string;
};

function cleanWorkspaceText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function deriveWorkspaceId(rootPath: string): string {
  const normalized = resolveUserDir(rootPath);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `local-${hash}`;
}

export function deriveWorkspaceName(rootPath: string): string {
  return basename(rootPath) || rootPath;
}

export function attachWorkspaceConfig(
  runtimeConfig: LocalAgentRuntimeConfig,
  options: Omit<WorkspaceRuntimeConfigOptions, 'workdir'> = {},
): LocalAgentRuntimeConfig {
  return freezeRuntimeConfig({
    ...runtimeConfig,
    workspace: Object.freeze({
      id: cleanWorkspaceText(options.workspaceId) ?? deriveWorkspaceId(runtimeConfig.workdir),
      name: cleanWorkspaceText(options.workspaceName) ?? deriveWorkspaceName(runtimeConfig.workdir),
      rootPath: runtimeConfig.workdir,
    }),
  });
}

export function buildWorkspaceRuntimeConfig(
  options: WorkspaceRuntimeConfigOptions = {},
): LocalAgentRuntimeConfig {
  return attachWorkspaceConfig(buildLocalAgentRuntimeConfig(options.workdir), options);
}
