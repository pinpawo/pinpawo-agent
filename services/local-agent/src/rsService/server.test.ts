import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RSServiceConnection } from './connection';
import { ensureToken, resolveRSServicePaths, type RSServicePaths } from './paths';
import { type RSServiceHandler, startRSService } from './server';
import { RSServiceError } from './transport';

const isWindows = process.platform === 'win32';
const contract = { contract: 'test.echo', version: 2 };

type Recorder = {
  aborted: string[];
  finished: string[];
  disposed: number;
};

function echoHandler(recorder: Recorder): RSServiceHandler {
  return {
    ...contract,
    async call(method, args, { signal }) {
      if (method === 'echo') return args;
      if (method === 'fail') {
        throw Object.assign(new Error('handler said no'), { code: 'not_allowed' });
      }
      if (method === 'slow') {
        const label = String(args);
        await new Promise<void>((resolvePromise) => {
          const timer = setTimeout(() => {
            recorder.finished.push(label);
            resolvePromise();
          }, 300);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            recorder.aborted.push(label);
            resolvePromise();
          }, { once: true });
        });
        return signal.aborted ? 'aborted' : 'done';
      }
      throw new Error(`unknown ${method}`);
    },
    async manage(action, args) {
      return { action, args };
    },
    describe: () => ({ items: 1 }),
    async dispose() {
      recorder.disposed += 1;
      return { cleaned: true };
    },
  };
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  const paths: RSServicePaths = resolveRSServicePaths(root);
  const token = await ensureToken(paths);
  const recorder: Recorder = { aborted: [], finished: [], disposed: 0 };
  const service = await startRSService({
    endpoint: paths.endpoint,
    token,
    handlers: [echoHandler(recorder)],
    log: () => {},
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { paths, token, recorder, service };
}

test('a client of a contract calls its operations', { skip: isWindows }, async (t) => {
  const { paths, token } = await setup(t);
  const client = await RSServiceConnection.open({ paths, token, rs: contract });
  t.after(async () => await client.close());

  assert.equal(client.servicePid, process.pid);
  assert.deepEqual(await client.call('echo', { a: [1, 'b'] }), { a: [1, 'b'] });
  await assert.rejects(
    client.call('fail', null),
    (error: unknown) => error instanceof RSServiceError
      && error.code === 'not_allowed'
      && error.message === 'handler said no',
  );
});

test('the token is the permission boundary', { skip: isWindows }, async (t) => {
  const { paths } = await setup(t);
  await assert.rejects(
    RSServiceConnection.open({ paths, token: 'f'.repeat(64), rs: contract }),
    (error: unknown) => error instanceof RSServiceError && error.code === 'unauthorized',
  );
});

test('the handshake checks the contract and its version', { skip: isWindows }, async (t) => {
  const { paths, token } = await setup(t);
  await assert.rejects(
    RSServiceConnection.open({ paths, token, rs: { contract: 'test.echo', version: 3 } }),
    (error: unknown) => error instanceof RSServiceError
      && error.code === 'contract_version_mismatch'
      && /pinpawo rs stop/.test(error.message),
  );
  await assert.rejects(
    RSServiceConnection.open({ paths, token, rs: { contract: 'test.other', version: 1 } }),
    (error: unknown) => error instanceof RSServiceError && error.code === 'contract_unavailable',
  );
});

test('cancellation aborts only the cancelled request', { skip: isWindows }, async (t) => {
  const { paths, token, recorder } = await setup(t);
  const client = await RSServiceConnection.open({ paths, token, rs: contract });
  t.after(async () => await client.close());

  const controller = new AbortController();
  const cancelled = client.call('slow', 'a', controller.signal);
  const kept = client.call('slow', 'b');
  setTimeout(() => controller.abort(), 50);
  assert.equal(await cancelled, 'aborted');
  assert.equal(await kept, 'done');
  assert.deepEqual(recorder.aborted, ['a']);
});

test('a closed connection loses its answers but cancels nothing', { skip: isWindows }, async (t) => {
  const { paths, token, recorder } = await setup(t);
  const client = await RSServiceConnection.open({ paths, token, rs: contract });

  const pending = client.call('slow', 'c');
  setTimeout(() => { void client.close(); }, 50);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof RSServiceError && error.code === 'connection_lost',
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  assert.deepEqual(recorder.aborted, []);
  assert.deepEqual(recorder.finished, ['c']);
});

test('the admin channel reports status, manages contracts and stops the service', { skip: isWindows }, async (t) => {
  const { paths, token, recorder, service } = await setup(t);
  const admin = await RSServiceConnection.open({ paths, token });
  t.after(async () => await admin.close());

  const status = await admin.admin('status') as { pid: number; rs: unknown[] };
  assert.equal(status.pid, process.pid);
  assert.deepEqual(status.rs, [{ contract: 'test.echo', version: 2, details: { items: 1 } }]);

  assert.deepEqual(
    await admin.admin('manage', { contract: 'test.echo', name: 'list', args: { x: 1 } }),
    { action: 'list', args: { x: 1 } },
  );

  // A contract client cannot use the admin channel.
  const client = await RSServiceConnection.open({ paths, token, rs: contract });
  t.after(async () => await client.close());
  await assert.rejects(
    client.admin('stop'),
    (error: unknown) => error instanceof RSServiceError && error.code === 'invalid_request',
  );

  const report = await admin.admin('stop');
  assert.deepEqual(report, { rs: [{ contract: 'test.echo', report: { cleaned: true } }] });
  assert.equal(recorder.disposed, 1);
  assert.deepEqual(await service.stopped, report);
  await assert.rejects(RSServiceConnection.open({ paths, token, rs: contract }));
});
