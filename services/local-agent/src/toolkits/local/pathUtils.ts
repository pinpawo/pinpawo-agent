import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { config } from '../../config';

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
  return resolve(config.workdir, path);
}
