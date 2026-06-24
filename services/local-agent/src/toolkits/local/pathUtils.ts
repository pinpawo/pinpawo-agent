import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { resolveDefaultWorkdir } from '../../runtimeConfig';

let localToolsWorkdir = resolveDefaultWorkdir();

export function setLocalToolsWorkdir(workdir: string) {
  localToolsWorkdir = workdir;
}

export function getLocalToolsWorkdir() {
  return localToolsWorkdir;
}

export function resolveUserPath(path: string) {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(localToolsWorkdir, path);
}
