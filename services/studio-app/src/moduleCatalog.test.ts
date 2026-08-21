import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedStudioModule } from '@pinpawo/studio';
import {
  createStudioModuleResolver,
  type StudioModuleRegistration,
} from './moduleCatalog';

test('Studio application catalog resolves a fresh installed Kanban module', async () => {
  const resolveModule = createStudioModuleResolver({ workdir: '/tmp/studio-catalog' });

  const first = await resolveModule('kanban');
  const second = await resolveModule('kanban', {});

  assert.equal(first.plugin.name, 'kanban');
  assert.deepEqual(first.capabilities?.map(({ name }) => name), ['studio_planning']);
  assert.notEqual(first.plugin, second.plugin);
});

test('installed Studio module catalog fails fast for unknown modules and invalid options', async () => {
  const resolveModule = createStudioModuleResolver({ workdir: '/tmp/studio-catalog' });

  await assert.rejects(
    async () => resolveModule('http'),
    /module "http" is not installed.*kanban/,
  );
  await assert.rejects(
    async () => resolveModule('kanban', { unexpected: true }),
    /does not support options: unexpected/,
  );
});

test('Studio module catalog rejects duplicate registrations before Host startup', () => {
  const create = (): ResolvedStudioModule => ({ plugin: {} as ResolvedStudioModule['plugin'] });
  const registrations: StudioModuleRegistration[] = [
    { id: 'duplicate', create },
    { id: 'duplicate', create },
  ];

  assert.throws(
    () => createStudioModuleResolver({ workdir: '/tmp/studio-catalog', registrations }),
    /Duplicate Studio module registration "duplicate"/,
  );
});

test('Studio module factories receive the application workdir', async () => {
  let receivedWorkdir = '';
  const resolveModule = createStudioModuleResolver({
    workdir: '/tmp/studio-workdir',
    registrations: [{
      id: 'test',
      create: (_options, context) => {
        receivedWorkdir = context.workdir;
        return { plugin: {} as ResolvedStudioModule['plugin'] };
      },
    }],
  });

  await resolveModule('test');
  assert.equal(receivedWorkdir, '/tmp/studio-workdir');
});
