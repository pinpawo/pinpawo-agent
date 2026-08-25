import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StudioPluginContext, StudioPluginHookInstaller } from '@pinpawo/studio';
import type { StudioHttpStaticMount } from '@pinpawo-plugin/studio-http';

import { createKanbanConsolePlugin } from './kanbanConsolePlugin';

test('Kanban Console contributes its packaged bundle through the HTTP static hook', async () => {
  let mount: StudioHttpStaticMount | undefined;
  let unregisterMount: (() => void) | undefined;
  const staticHook = {
    register: (nextMount: StudioHttpStaticMount) => {
      mount = nextMount;
      return () => { mount = undefined; };
    },
  };
  const context: StudioPluginContext = {
    dispatch: async () => { throw new Error('not used'); },
    onInvocation: () => () => undefined,
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => [],
    hooks: {
      expose: () => () => undefined,
      contribute: <T>(_pluginName: string, hookName: string, install: StudioPluginHookInstaller<T>) => {
        assert.equal(hookName, 'static');
        const cleanup = install(staticHook as T);
        unregisterMount = typeof cleanup === 'function' ? cleanup : undefined;
        return () => unregisterMount?.();
      },
    },
  };
  const plugin = createKanbanConsolePlugin();
  assert.deepEqual(plugin.toolkits, []);
  await plugin.start(context);
  assert.equal(plugin.name, 'kanban-console');
  assert.equal(mount?.mountPath, '/');
  assert.equal(mount?.fallback, 'index.html');
  assert.match(new TextDecoder().decode((await mount?.resolve('index.html'))?.body), /Kanban Console/);
  assert.equal(await mount?.resolve('../outside'), undefined);

  await plugin.stop?.();
  assert.equal(mount, undefined);
});
