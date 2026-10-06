import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { startupStoredConfig, type StoredConfig } from '../storage';

export type AgentWorkspaceConfig = Readonly<{
  id: string;
  name: string;
  rootPath: string;
}>;

export type HostRuntimeConfig = Readonly<{
  workdir: string;
  workspace?: AgentWorkspaceConfig;
  stateRoot: string;
  checkpointPath: string;
  tuiCheckpointPath: string;
  tuiSessionPath: string;
  /** Pet configuration directory; Chat reads one Pet here, Studio reads many. */
  petsDir: string;
  capabilityArtifactRoot: string;
}>;

/**
 * Serialized graph state is versioned by namespace instead of migrated: a
 * contract change starts a new durable namespace rather than interpreting older
 * checkpoints through the new graph. v3 made the Supervisor snapshot's `runId`
 * required; v4 stores delegation results as typed execution records. Capability artifacts keep their existing thread-scoped root.
 */
export const HOST_CHECKPOINT_CONTRACT = 'capability-v4';

/** Independent local Hosts must use distinct FileSaver writer roots. */
export function resolveHostCheckpointPath(
  runtimeConfig: Pick<HostRuntimeConfig, 'stateRoot'>,
  hostId: string,
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hostId)) {
    throw new Error(`Invalid local Host checkpoint id: ${hostId}`);
  }
  return resolve(
    runtimeConfig.stateRoot,
    `checkpoints-${hostId}-${HOST_CHECKPOINT_CONTRACT}.json`,
  );
}

const LEGACY_LOCAL_STATE_NAMES = [
  'checkpoints.json',
  'checkpoints',
  'checkpoints-tui.json',
  'checkpoints-tui',
  'tui-sessions.json',
] as const;

function freezeRuntimeConfig(input: HostRuntimeConfig): HostRuntimeConfig {
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
  stored: Pick<StoredConfig, 'workdir'> = startupStoredConfig,
): string {
  return env.PINPAWO_WORKDIR?.trim()
    || (typeof stored.workdir === 'string' ? stored.workdir.trim() : '')
    || process.cwd()
    || homedir();
}

export function buildHostRuntimeConfig(workdir = resolveDefaultWorkdir()): HostRuntimeConfig {
  const resolvedWorkdir = resolveUserDir(workdir || homedir());
  const stateRoot = resolve(resolvedWorkdir, '.pinpawo');
  return freezeRuntimeConfig({
    workdir: resolvedWorkdir,
    stateRoot,
    checkpointPath: resolve(
      stateRoot,
      `checkpoints-${HOST_CHECKPOINT_CONTRACT}.json`,
    ),
    tuiCheckpointPath: resolve(
      stateRoot,
      `checkpoints-tui-${HOST_CHECKPOINT_CONTRACT}.json`,
    ),
    tuiSessionPath: resolve(
      stateRoot,
      `tui-sessions-${HOST_CHECKPOINT_CONTRACT}.json`,
    ),
    petsDir: resolve(stateRoot, 'pets'),
    capabilityArtifactRoot: resolve(stateRoot, 'capability-artifacts'),
  });
}

/**
 * Capability V2 intentionally does not reinterpret pre-V2 checkpoint state.
 * Report preserved legacy paths so the namespace change is visible without
 * deleting data that a user may still want to archive or inspect.
 */
export function findLegacyHostState(
  runtimeConfig: Pick<HostRuntimeConfig, 'stateRoot'>,
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
  runtimeConfig: HostRuntimeConfig,
  options: Omit<WorkspaceRuntimeConfigOptions, 'workdir'> = {},
): HostRuntimeConfig {
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
): HostRuntimeConfig {
  return attachWorkspaceConfig(buildHostRuntimeConfig(options.workdir), options);
}
