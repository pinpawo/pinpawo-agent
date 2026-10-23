/**
 * The TUI's display language. The Host holds no locale: it sends notices as
 * codes with English default text, and the TUI renders them here.
 */
export type TuiLocale = 'en' | 'zh';

/**
 * `PINPAWO_LOCALE` overrides the system locale; otherwise the POSIX order
 * `LC_ALL`, `LC_MESSAGES`, `LANG` decides. Anything but Chinese is English.
 */
export function resolveTuiLocale(env: NodeJS.ProcessEnv): TuiLocale {
  const value = [env.PINPAWO_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .map((candidate) => candidate?.trim())
    .find(Boolean);
  return value && /^zh\b|^zh[_-]/i.test(value) ? 'zh' : 'en';
}

// English until startup resolves the environment, so tests and probes render
// the same text on every machine.
let currentLocale: TuiLocale = 'en';

export function tuiLocale(): TuiLocale {
  return currentLocale;
}

export function setTuiLocale(locale: TuiLocale) {
  currentLocale = locale;
}
