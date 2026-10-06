/**
 * Permission levels of argv CLI invocations (git, gh).
 *
 * - `read`: only reads. Runs anywhere without review, `inspect_shell` included.
 * - `change`: an everyday, recoverable write. Runs in `git_shell` / `gh_shell`
 *   without review; `inspect_shell` redirects it there.
 * - `risky`: loses data, rewrites shared history, or affects others or
 *   credentials. Reviewed in `git_shell` / `gh_shell`.
 *
 * The policy leans permissive: only clearly irreversible or shared-impact forms
 * are `risky`. Unrecognized subcommands and aliases are `risky` too, because
 * their effect is unknown; the cost of a wrong "risky" is one review.
 */
export type CliLevel = 'read' | 'change' | 'risky';
export type CliVerdict = { level: 'read' } | { level: 'change' | 'risky'; reason: string };

export const READ: CliVerdict = { level: 'read' };
export const change = (reason: string): CliVerdict => ({ level: 'change', reason });
export const risky = (reason: string): CliVerdict => ({ level: 'risky', reason });

/** Flags that end option parsing; everything after is a pathspec or operand. */
export function beforeDoubleDash(args: readonly string[]) {
  const end = args.indexOf('--');
  return end === -1 ? args : args.slice(0, end);
}

/** A bundle like `-vv` or `-dr`, checked one letter at a time. */
export function shortBundle(arg: string) {
  return /^-[A-Za-z]+$/.test(arg) ? arg.slice(1).split('') : [];
}

/** Whether any option (before `--`) is one of the long names or short letters. */
export function hasOption(args: readonly string[], long: readonly string[], short = '') {
  return beforeDoubleDash(args).some((arg) => long.includes(arg.split('=')[0])
    || shortBundle(arg).some((letter) => short.includes(letter)));
}
