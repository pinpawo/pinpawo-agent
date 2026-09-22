import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function parseDotEnv(content: string) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Load local environment settings without reading or validating model profiles. */
export function loadLocalEnvironment(): void {
  // Existing process values win; the user file then takes precedence over cwd.
  for (const file of [resolve(homedir(), '.pinpawo', '.env'), resolve(process.cwd(), '.env')]) {
    try { parseDotEnv(readFileSync(file, 'utf8')); } catch { /* Optional files. */ }
  }
}
