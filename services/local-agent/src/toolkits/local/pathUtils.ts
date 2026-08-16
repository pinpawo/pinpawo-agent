import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { ToolRuntime } from '@langchain/core/tools';
import type { SubagentRuntimeContext } from '@pinpawo/pet-agent';
import { resolveDefaultWorkdir } from '../../runtimeConfig';

export type LocalToolRuntime = ToolRuntime<unknown, SubagentRuntimeContext>;

export function resolveToolExecutionWorkdir(
  runtime?: Pick<LocalToolRuntime, 'context'>,
) {
  const workdir = runtime?.context?.executionScope?.workdir;
  return typeof workdir === 'string' && workdir.trim()
    ? workdir
    : resolveDefaultWorkdir();
}

export function resolveUserPath(path: string, workdir = resolveDefaultWorkdir()) {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(workdir, path);
}

export function resolveToolPath(
  path: string,
  runtime?: Pick<LocalToolRuntime, 'context'>,
) {
  return resolveUserPath(path, resolveToolExecutionWorkdir(runtime));
}
