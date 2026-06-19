import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { loadStoredConfig, type StoredConfig } from './storage';

export type LocalAgentRuntimeConfig = {
  workdir: string;
  stateRoot: string;
  studioConfigPath: string;
  petsDir: string;
  studioWikiBaseDir: string;
  checkpointPath: string;
  tuiCheckpointPath: string;
  tuiSessionPath: string;
  capabilityArtifactRoot: string;
};

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
  return {
    workdir: resolvedWorkdir,
    stateRoot,
    studioConfigPath: resolve(stateRoot, 'studio.json'),
    petsDir: resolve(stateRoot, 'pets'),
    studioWikiBaseDir: resolve(stateRoot, 'studio-wiki'),
    checkpointPath: resolve(stateRoot, 'checkpoints.json'),
    tuiCheckpointPath: resolve(stateRoot, 'checkpoints-tui.json'),
    tuiSessionPath: resolve(stateRoot, 'tui-sessions.json'),
    capabilityArtifactRoot: resolve(stateRoot, 'capability-artifacts'),
  };
}
