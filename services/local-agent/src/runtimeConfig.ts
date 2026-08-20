import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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

/**
 * The Capability V2 graph changed serialized lane semantics. Local state uses
 * a new durable namespace instead of interpreting pre-V2 checkpoints through
 * the new graph. Capability artifacts keep their existing thread-scoped root.
 */
export const LOCAL_AGENT_CHECKPOINT_CONTRACT = 'capability-v2';

/** Independent local Hosts must use distinct FileSaver writer roots. */
export function resolveHostCheckpointPath(
  runtimeConfig: Pick<LocalAgentRuntimeConfig, 'stateRoot'>,
  hostId: string,
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hostId)) {
    throw new Error(`Invalid local Host checkpoint id: ${hostId}`);
  }
  return resolve(
    runtimeConfig.stateRoot,
    `checkpoints-${hostId}-${LOCAL_AGENT_CHECKPOINT_CONTRACT}.json`,
  );
}

const LEGACY_LOCAL_STATE_NAMES = [
  'checkpoints.json',
  'checkpoints',
  'checkpoints-tui.json',
  'checkpoints-tui',
  'tui-sessions.json',
] as const;

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
    checkpointPath: resolve(
      stateRoot,
      `checkpoints-${LOCAL_AGENT_CHECKPOINT_CONTRACT}.json`,
    ),
    tuiCheckpointPath: resolve(
      stateRoot,
      `checkpoints-tui-${LOCAL_AGENT_CHECKPOINT_CONTRACT}.json`,
    ),
    tuiSessionPath: resolve(
      stateRoot,
      `tui-sessions-${LOCAL_AGENT_CHECKPOINT_CONTRACT}.json`,
    ),
    capabilityArtifactRoot: resolve(stateRoot, 'capability-artifacts'),
  });
}

/**
 * Capability V2 intentionally does not reinterpret pre-V2 checkpoint state.
 * Report preserved legacy paths so the namespace change is visible without
 * deleting data that a user may still want to archive or inspect.
 */
export function findLegacyLocalAgentState(
  runtimeConfig: Pick<LocalAgentRuntimeConfig, 'stateRoot'>,
): string[] {
  return LEGACY_LOCAL_STATE_NAMES
    .map((name) => resolve(runtimeConfig.stateRoot, name))
    .filter((path) => existsSync(path));
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
