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

/**
 * Directory names that file walks (grep_search / glob_search) must never descend
 * into. `.pinpawo` is hardcoded on purpose: it holds the agent's own checkpoint /
 * artifact storage, and recursively reading it back into context causes a
 * self-reference blow-up (a single serialized checkpoint object is one ~493KB line
 * of conversation JSON). See docs/GUARD_REGISTRY_DESIGN.md for current guard
 * boundaries.
 */
export const DEFAULT_WALK_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.pinpawo',
  '.git',
  'node_modules',
]);

export function walkFiles(
  rootPath: string,
  visit: (filePath: string) => boolean | void,
  ignoredDirs: ReadonlySet<string> = DEFAULT_WALK_IGNORED_DIRS,
) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = tryStat(current);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = readdirSync(current);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const name = entries[i] ?? '';
        if (ignoredDirs.has(name)) {
          continue;
        }
        stack.push(resolve(current, name));
      }
      continue;
    }
    if (visit(current) === false) {
      return;
    }
  }
}
