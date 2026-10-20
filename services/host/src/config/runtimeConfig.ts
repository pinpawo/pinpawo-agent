import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { loadStoredConfig, type StoredConfig } from '../storage';

export type AgentWorkspaceConfig = Readonly<{
  id: string;
  name: string;
  rootPath: string;
}>;

export type HostRuntimeConfig = Readonly<{
  workdir: string;
  workspace?: AgentWorkspaceConfig;
  /** Project configuration (`<workdir>/.pinpawo`): Pets and Studio config. */
  stateRoot: string;
  /**
   * Session state of this workdir under the user's home: checkpoints, session
   * registries and capability artifacts. See `resolveWorkspaceSessionRoot`.
   */
  sessionRoot: string;
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
 * required; v4 stores delegation results as typed execution records; v5 keeps
 * FileSaver objects inside each thread directory. Capability artifacts keep their existing thread-scoped root.
 */
export const HOST_CHECKPOINT_CONTRACT = 'capability-v5';

/** Independent local Hosts must use distinct FileSaver writer roots. */
export function resolveHostCheckpointPath(
  runtimeConfig: Pick<HostRuntimeConfig, 'sessionRoot'>,
  hostId: string,
): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(hostId)) {
    throw new Error(`Invalid local Host checkpoint id: ${hostId}`);
  }
  return resolve(
    runtimeConfig.sessionRoot,
    `checkpoints-${hostId}-${HOST_CHECKPOINT_CONTRACT}.json`,
  );
}

/** Session state names that older versions kept in `<workdir>/.pinpawo`. */
function isLegacyWorkdirSessionState(name: string): boolean {
  return /^(checkpoints|tui-sessions)([-.]|$)/.test(name)
    || name === 'capability-artifacts'
    || name === 'resident-sessions';
}

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
  stored: Pick<StoredConfig, 'workdir'> = loadStoredConfig(),
): string {
  return env.PINPAWO_WORKDIR?.trim()
    || (typeof stored.workdir === 'string' ? stored.workdir.trim() : '')
    || process.cwd()
    || homedir();
}

/**
 * Sessions of every workdir live under one home directory, one subdirectory
 * per workdir: a FileSaver root admits a single writing Host, so Hosts running
 * in different projects must not share one. `PINPAWO_WORKSPACES_DIR` moves the
 * base directory (tests point it at a temporary directory).
 */
export function resolveWorkspaceSessionRoot(
  workdir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.PINPAWO_WORKSPACES_DIR?.trim()
    ? resolveUserDir(env.PINPAWO_WORKSPACES_DIR)
    : resolve(homedir(), '.pinpawo', 'workspaces');
  return resolve(base, deriveWorkspaceId(workdir));
}

export function buildHostRuntimeConfig(workdir = resolveDefaultWorkdir()): HostRuntimeConfig {
  const resolvedWorkdir = resolveUserDir(workdir || homedir());
  const stateRoot = resolve(resolvedWorkdir, '.pinpawo');
  const sessionRoot = resolveWorkspaceSessionRoot(resolvedWorkdir);
  return freezeRuntimeConfig({
    workdir: resolvedWorkdir,
    stateRoot,
    sessionRoot,
    checkpointPath: resolve(
      sessionRoot,
      `checkpoints-${HOST_CHECKPOINT_CONTRACT}.json`,
    ),
    tuiCheckpointPath: resolve(
      sessionRoot,
      `checkpoints-tui-${HOST_CHECKPOINT_CONTRACT}.json`,
    ),
    tuiSessionPath: resolve(
      sessionRoot,
      `tui-sessions-${HOST_CHECKPOINT_CONTRACT}.json`,
    ),
    petsDir: resolve(stateRoot, 'pets'),
    capabilityArtifactRoot: resolve(sessionRoot, 'capability-artifacts'),
  });
}

/**
 * Session state is neither migrated nor read from the workdir. Report what an
 * older version left in `<workdir>/.pinpawo` so the user can delete it.
 */
export function findLegacyHostState(
  runtimeConfig: Pick<HostRuntimeConfig, 'stateRoot'>,
): string[] {
  let names: string[];
  try {
    names = readdirSync(runtimeConfig.stateRoot);
  } catch {
    return [];
  }
  return names
    .filter(isLegacyWorkdirSessionState)
    .sort()
    .map((name) => resolve(runtimeConfig.stateRoot, name));
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
