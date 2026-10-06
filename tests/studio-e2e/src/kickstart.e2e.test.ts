import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initStudioWorkdir, type StudioPlugin } from '@pinpawo/studio';

test('Studio init enables Channel and keeps only an explicit external-request Trigger', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-init-e2e-'));
  await initStudioWorkdir({ workdir });
  const config = await readFile(path.join(workdir, '.pinpawo', 'studio.json'), 'utf8');
  const parsed = JSON.parse(config) as {
    plugins: Array<{
      id: string;
      options?: {
        triggers?: Array<{
          triggerId: string;
          source?: { secretEnv?: string };
        }>;
      };
    }>;
  };
  assert.ok(parsed.plugins.some(({ id }) => id === '@pinpawo-plugin/channel'));
  const trigger = parsed.plugins.find(({ id }) => id === '@pinpawo-plugin/trigger');
  assert.equal(trigger?.options?.triggers?.length, 1);
  assert.ok(trigger?.options?.triggers?.some((definition) => (
    definition.triggerId === 'external-request'
    && definition.source?.secretEnv === 'PINPAWO_STUDIO_TRIGGER_SECRET'
  )));
});

// Assemble the shipped Plugin selection and exercise the surviving public routes.
test('shipped Plugins support explicit Wiki work and Knowledge without opening historical task storage', async (t) => {
  const { mkdir, rm, writeFile } = await import('node:fs/promises');
  const { createStudio, resolveStudioHostConfig } = await import('@pinpawo/studio');
  const { createStudioHttpPlugin } = await import('@pinpawo-plugin/studio-http');
  const { createStudioPlugin: channelFactory } = await import('@pinpawo-plugin/channel');
  const { createStudioPlugin: noticeFactory } = await import('@pinpawo-plugin/notice');
  const { createStudioPlugin: schedulerFactory } = await import('@pinpawo-plugin/scheduler');
  const { createStudioPlugin: filesFactory } = await import('@pinpawo-plugin/project-files');
  const { createTriggerPlugin } = await import('@pinpawo-plugin/trigger');
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-retired-workdir-'));
  await initStudioWorkdir({ workdir });
  const historyDir = path.join(workdir, '.pinpawo', 'kanban');
  await mkdir(historyDir, { recursive: true });
  const history = path.join(historyDir, 'tasks.sqlite');
  const archived = Buffer.from('historical storage must not be opened or migrated');
  await writeFile(history, archived);
  const configPath = path.join(workdir, '.pinpawo', 'studio.json');
  const beforeConfig = await readFile(configPath);
  const beforeWiki = await readFile(path.join(workdir, 'wiki', 'PROJECT.md'));
  const token = 'explicit-wiki-test-token';
  const http = createStudioHttpPlugin({ port: 0, authToken: token });
  const factories = new Map<string, (
    options: Record<string, unknown> | undefined,
    environment: { workdir: string },
  ) => StudioPlugin>([
    ['@pinpawo-plugin/channel', channelFactory],
    ['@pinpawo-plugin/notice', noticeFactory],
    ['@pinpawo-plugin/scheduler', schedulerFactory],
    ['@pinpawo-plugin/project-files', filesFactory],
  ]);
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      if (id === '@pinpawo-plugin/studio-http') return http;
      if (id === '@pinpawo-plugin/trigger') {
        // Supply test credentials without consulting or mutating user environment.
        const definitions = options!.triggers as Array<{ triggerId: string; petId: string; request: string }>;
        return createTriggerPlugin({ triggers: definitions.map(({ triggerId, petId, request }) => ({
          triggerId, petId, request, source: { kind: 'http' as const, secret: 'explicit-planning-test-secret' },
        })) });
      }
      const factory = factories.get(id);
      assert.ok(factory, `Unexpected configured Plugin: ${id}`);
      return factory(options, { workdir });
    },
  });
  const { compileAgentRegistry } = await import('@pinpawo/pet-agent');
  const { loadCapabilityDirectory } = await import('pinpawo/host-runtime');
  const { createFilesToolkit } = await import('../../../services/host/src/toolkits/files/index');
  const { createShellToolkit } = await import('../../../services/host/src/toolkits/shell/index');
  const { createWebToolkit } = await import('../../../services/host/src/toolkits/web/index');
  const { createGitToolkit } = await import('../../../services/host/src/toolkits/git/index');
  const { createGithubToolkit } = await import('../../../services/host/src/toolkits/github/index');
  const { createProjectInspectionToolkit } = await import('../../../services/host/src/toolkits/projectInspection');
  const { PosixShellRS } = await import('../../../services/host/src/toolkits/shellRS/index');
  const { createStudioContextToolkit } = await import('../../../packages/studio/src/host/studioContextToolkit');
  const shell = new PosixShellRS();
  t.after(() => shell.dispose());
  const toolkits = [
    createFilesToolkit(), createShellToolkit({ shell: shell }), createWebToolkit(), createGitToolkit({ shell: shell }), createGithubToolkit({ shell: shell }), createProjectInspectionToolkit({ shell }),
    createStudioContextToolkit(() => configuration.resolved.pets.map(({ petId, name }) => ({ petId, name }))),
    ...configuration.plugins.flatMap((plugin) => plugin.toolkits),
  ];
  for (const pet of configuration.resolved.pets) {
    const loaded = await loadCapabilityDirectory(path.join(workdir, '.pinpawo', 'pets', pet.petId, 'capabilities'));
    const registry = compileAgentRegistry({ toolkits, capabilities: loaded.map(({ capability }) => capability) });
    assert.deepEqual(registry.unavailableCapabilities, [], `${pet.petId} has no missing Toolkit bindings`);
    const preferred = registry.capabilities.find(({ capability }) => capability.name === pet.defaultCapabilityName);
    assert.ok(preferred, `${pet.petId} retains an executable default Capability`);
    assert.ok(preferred.toolNames.includes('channel_read_context'));
    if (pet.petId === 'wiki') assert.ok(preferred.toolNames.includes('write_file'));
  }
  const received: Array<{ petId: string; request: string }> = [];
  const studio = await createStudio({
    studioId: configuration.resolved.studio.studioId,
    entryPetId: configuration.resolved.studio.entryPetId,
    plugins: configuration.plugins,
    pets: configuration.resolved.pets.map(({ petId, name }) => ({
      registration: { petId, name },
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
        dispatch: async ({ request }) => { received.push({ petId, request }); },
      },
    })),
  });
  t.after(async () => {
    await studio.shutdown();
    await rm(workdir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.deepEqual(studio.listPets().map(({ petId }) => petId), ['planner', 'executor', 'reviewer', 'wiki']);
  for (const route of ['/kanban', '/kanban/events']) {
    assert.equal((await fetch(base + route, { headers })).status, 404);
  }
  assert.equal((await fetch(base + '/kanban/control', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/channels', { headers })).status, 200);
  const knowledge = await fetch(base + '/knowledge', { headers });
  assert.equal(knowledge.status, 200);
  const listing = await knowledge.json() as { documents: Array<{ path: string }> };
  assert.deepEqual(listing.documents.map(({ path }) => path), ['PROJECT.md']);
  const document = await fetch(base + '/knowledge/document?path=PROJECT.md', { headers });
  assert.equal(document.status, 200);
  assert.equal((await document.json() as { document: { content: string } }).document.content, beforeWiki.toString());
  studio.notify({
    source: 'resident-pet', type: 'dispatch.completed',
    occurredAt: new Date().toISOString(),
    payload: { petId: 'executor', invocationId: 'completed-work', reply: 'Delivery evidence' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [], 'Invocation completion does not dispatch Wiki maintenance');
  const request = 'Reconcile Wiki from the supplied review evidence.';
  assert.equal((await fetch(base + '/dispatch', {
    method: 'POST', headers, body: JSON.stringify({ petId: 'wiki', request }),
  })).status, 202);
  assert.deepEqual(received, [{ petId: 'wiki', request }]);
  assert.deepEqual(await readFile(history), archived);
  assert.deepEqual(await readFile(configPath), beforeConfig);
  assert.deepEqual(await readFile(path.join(workdir, 'wiki', 'PROJECT.md')), beforeWiki);
});
