import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import this before the Host modules: their default-config loader otherwise
// reads the operator's config and dotenv files even with an explicit registry.
const config = path.resolve(homedir(), '.pinpawo', 'config.json');
const dotenv = new Set([path.resolve(homedir(), '.pinpawo', '.env'), path.resolve(process.cwd(), '.env')]);
const profile = 'scenario-bootstrap';
const synthetic = JSON.stringify({ models: { version: 1, defaultProfileId: profile, profiles: {
  [profile]: { id: profile, label: 'Scenario bootstrap', provider: 'scenario', model: profile,
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'scenario-bootstrap-only',
    contextWindowTokens: 32_000, inputModalities: ['text'] },
} } });
const stats = { personalConfigReadsReplaced: 0, dotenvReadsBlocked: 0 };
const readFile = fs.readFileSync;
fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  const filename = typeof file === 'string' ? path.resolve(file) : file instanceof URL
    ? path.resolve(fileURLToPath(file)) : Buffer.isBuffer(file) ? path.resolve(file.toString()) : undefined;
  if (filename === config) {
    stats.personalConfigReadsReplaced++;
    const option = args[0];
    const encoding = typeof option === 'string' ? option : option && typeof option === 'object' && 'encoding' in option
      ? (option as { encoding?: string }).encoding : undefined;
    return encoding ? synthetic : Buffer.from(synthetic);
  }
  if (filename && dotenv.has(filename)) {
    stats.dotenvReadsBlocked++;
    throw Object.assign(new Error('Scenario dotenv access blocked.'), { code: 'ENOENT' });
  }
  return Reflect.apply(readFile, fs, [file, ...args]);
}) as typeof fs.readFileSync;
delete process.env.PINPAWO_MODEL_PROFILE;
for (const key of ['LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING',
  'LANGSMITH_TRACING_V2', 'LANGFUSE_TRACING_ENABLED']) process.env[key] = 'false';
syncBuiltinESMExports();

export function scenarioConfigIsolationStats() { return { ...stats }; }
