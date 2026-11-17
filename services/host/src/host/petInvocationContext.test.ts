import assert from 'node:assert/strict';
import test from 'node:test';
import { copyPetInvocationScope, readPetInvocationContext, withPetInvocationContext, withoutPetInvocationContext } from './petInvocationContext';

test('invocation context is isolated, immutable and revoked even in retained asynchronous descendants', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let late!: Promise<unknown>;
  await Promise.all(['a', 'b'].map(async (id) => {
    await withPetInvocationContext({ petId: id, dispatchId: id, scope: { namespace: 'channel', id } }, async () => {
      await Promise.resolve();
      assert.equal(readPetInvocationContext()?.petId, id);
      assert.equal(readPetInvocationContext()?.scope?.id, id);
      assert.ok(Object.isFrozen(readPetInvocationContext()?.scope));
      await withoutPetInvocationContext(async () => {
        await Promise.resolve();
        assert.equal(readPetInvocationContext(), undefined);
      });
      assert.equal(readPetInvocationContext()?.petId, id);
      if (id === 'a') late = pending.then(() => readPetInvocationContext());
    });
  }));
  assert.equal(readPetInvocationContext(), undefined);
  release();
  assert.equal(await late, undefined);
  await assert.rejects(withPetInvocationContext({ petId: 'a', dispatchId: 'failure' }, async () => { throw new Error('failure'); }));
  assert.equal(readPetInvocationContext(), undefined);
});

test('scope admits only explicit opaque references', () => {
  for (const input of [{ namespace: '', id: 'a' }, { namespace: 'channel' }, { namespace: 'channel', id: 'a', petId: 'spoof' }]) {
    assert.throws(() => copyPetInvocationScope(input as never));
  }
});
