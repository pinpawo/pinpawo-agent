import { parse } from 'shell-quote';
import { classifyGhArgs } from '../cli/ghCommands';
import { classifyGitArgs } from '../cli/gitCommands';

const CHAIN_OPERATORS = new Set(['&&', '||', ';']);

/**
 * Whether a `run_shell` command needs review.
 *
 * Plain git and gh invocations that are not risky (reads and everyday writes
 * such as commit, push or a PR comment) run unreviewed, optionally after `cd`
 * and chained with `&&`, `||` or `;`. Anything else is reviewed: other
 * programs, risky git/gh forms, and any pipe, redirect, glob, variable or
 * command substitution, whose effect this check does not follow.
 */
export function runShellCommandNeedsReview(command: string): boolean {
  if (!command.trim() || /[$`<>\\\n]/.test(command)) return true;
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    return true;
  }
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (typeof token === 'string') {
      segments[segments.length - 1].push(token);
    } else if ('op' in token && CHAIN_OPERATORS.has(token.op)) {
      segments.push([]);
    } else {
      return true;
    }
  }
  let ranCli = false;
  for (const [program, ...args] of segments) {
    if (program === undefined) continue;
    if (program === 'cd' && args.length <= 1) continue;
    const verdict = program === 'git' ? classifyGitArgs(args) : program === 'gh' ? classifyGhArgs(args) : null;
    if (!verdict || verdict.level === 'risky') return true;
    ranCli = true;
  }
  return !ranCli;
}
