import { statSync } from 'node:fs';

export function tryStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}
