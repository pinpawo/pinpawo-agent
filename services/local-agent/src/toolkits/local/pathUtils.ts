import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { resolveDefaultWorkdir } from '../../runtimeConfig';

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
