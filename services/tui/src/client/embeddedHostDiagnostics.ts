/**
 * Host stderr sink for embedded stdio mode.
 *
 * The embedded Host writes startup, toolkit, and shutdown diagnostics to
 * stderr. They must never reach the terminal — OpenTUI owns that screen — and
 * the Host has no HTTP `/runtime` surface in this mode, so the log file is the
 * only place an operator can read them.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const DEFAULT_EMBEDDED_HOST_LOG_PATH = resolve(
  homedir(),
  '.pinpawo',
  'logs',
  'embedded-host.log',
);

export function createEmbeddedHostDiagnosticsSink(
  path = DEFAULT_EMBEDDED_HOST_LOG_PATH,
): (line: string) => void {
  let writable = true;
  let directoryReady = false;
  return (line: string) => {
    if (!writable) return;
    try {
      if (!directoryReady) {
        mkdirSync(dirname(path), { recursive: true });
        directoryReady = true;
      }
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Diagnostics are best effort: a read-only or missing home directory
      // must not take the terminal UI down with it.
      writable = false;
    }
  };
}
