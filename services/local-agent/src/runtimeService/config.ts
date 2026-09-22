import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { record, RuntimeServiceError } from './protocol';
import type { RuntimeServiceConfig } from './types';

export function runtimeServicePaths(directory = process.env.PINPAWO_RUNTIME_DIR ?? resolve(homedir(), '.pinpawo', 'runtime')) {
  const root = resolve(directory);
  const key = createHash('sha256').update(`${userInfo().username}:${root}`).digest('hex').slice(0, 20);
  return {
    root,
    endpoint: process.platform === 'win32'
      ? `\\\\.\\pipe\\pinpawo-runtime-${key}`
      : resolve(tmpdir(), `ppr-${key}`, 's'),
    config: resolve(root, 'config.json'),
    token: resolve(root, 'token'),
    lock: resolve(root, 'service.lock'),
    log: resolve(root, 'service.log'),
  };
}

export async function loadRuntimeServiceConfig(path: string): Promise<RuntimeServiceConfig> {
  let source: unknown;
  try { source = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    source = {
      instances: { local: { kind: 'shell', pathBase: dirname(path) }, browser: { kind: 'cdp' } },
      toolkitBindings: { bash: 'local', git: 'local', 'project-inspection': 'local', browser: 'browser' },
    };
  }
  const input = record(source);
  const instances = record(input.instances);
  const bindings = record(input.toolkitBindings);
  for (const [name, value] of Object.entries(instances)) {
    const entry = record(value);
    if (Object.hasOwn(entry, 'type')) {
      throw new RuntimeServiceError('invalid_config', `Runtime instance "${name}" uses removed field "type"; use "kind".`);
    }
    if (!name.trim() || typeof entry.kind !== 'string' || !entry.kind.trim()) {
      throw new RuntimeServiceError('invalid_config', 'Every Runtime instance needs a name and kind.');
    }
  }
  for (const [name, instanceId] of Object.entries(bindings)) {
    if (!name.trim() || typeof instanceId !== 'string' || !Object.hasOwn(instances, instanceId)) {
      throw new RuntimeServiceError('invalid_config', `Invalid Runtime binding for Toolkit: ${name}`);
    }
  }
  if (input.modules !== undefined && (!Array.isArray(input.modules)
    || input.modules.some((path) => typeof path !== 'string' || !isAbsolute(path)))) {
    throw new RuntimeServiceError('invalid_config', 'Runtime module paths must be operator-configured absolute paths.');
  }
  return JSON.parse(JSON.stringify(input)) as RuntimeServiceConfig;
}
