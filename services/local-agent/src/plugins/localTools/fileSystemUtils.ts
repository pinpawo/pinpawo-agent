import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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

export function walkFiles(rootPath: string, visit: (filePath: string) => boolean | void) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = tryStat(current);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = readdirSync(current);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        stack.push(resolve(current, entries[i] ?? ''));
      }
      continue;
    }
    if (visit(current) === false) {
      return;
    }
  }
}
