import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initStudioWorkdir } from '@pinpawo/studio';

test('Studio init ships a user-assignment Trigger rule instead of Kanban Pet configuration', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-init-e2e-'));
  await initStudioWorkdir({ workdir });
  const config = await readFile(path.join(workdir, '.pinpawo', 'studio.json'), 'utf8');
  const parsed = JSON.parse(config) as {
    plugins: Array<{
      id: string;
      options?: {
        triggers?: Array<{
          triggerId: string;
          target?: { kind: string; path?: string };
          source?: { secretEnv?: string };
        }>;
      };
    }>;
  };
  const kanban = parsed.plugins.find(({ id }) => id === '@pinpawo-plugin/kanban');
  const trigger = parsed.plugins.find(({ id }) => id === '@pinpawo-plugin/trigger');
  assert.equal(kanban?.options, undefined);
  assert.ok(trigger?.options?.triggers?.some((definition) => (
    definition.triggerId === 'external-request'
    && definition.source?.secretEnv === 'PINPAWO_STUDIO_TRIGGER_SECRET'
  )));
  assert.ok(trigger?.options?.triggers?.some((definition) => (
    definition.triggerId === 'dispatch-assigned-kanban-task'
    && definition.target?.kind === 'event_payload'
    && definition.target.path === 'payload.assigneeId'
  )));
});
