/** Argument helpers for recognizing read-only git/gh invocations (`gitCommands.ts`, `ghCommands.ts`). */

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
