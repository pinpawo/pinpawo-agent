import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStudioOperatorArgs, runStudioOperator } from './studioOperatorCli';
import { runStudioHostCli } from './cli';

test('operator parser accepts connection flags on either side and rejects incompatible options', () => {
  const parsed = parseStudioOperatorArgs(['--studio-url', 'http://127.0.0.1:3291', 'channels', 'read', 'channel a', '--agent-url', 'http://127.0.0.1:3292', '--after', '4', '--limit', '2'])!;
  assert.equal(parsed.id, 'channel a');
  assert.equal(parsed.studioUrl, 'http://127.0.0.1:3291');
  assert.equal(parsed.agentUrl, 'http://127.0.0.1:3292');
  assert.equal(parsed.after, 4);
  assert.equal(parsed.limit, 2);
  for (const args of [
    ['channels'], ['channels', 'read'], ['channels', 'list', 'extra'],
    ['channels', 'send', 'c'], ['channels', 'read', 'c', '--mention', 'pet:a'],
    ['channels', 'list', '--limit', '201'], ['channels', 'read', 'c', '--after', '-1'],
    ['channels', 'list', '--after', '1e3'], ['channels', 'list', '--limit', '1', '--limit', '2'],
    ['events', 'p', '--seconds', '0'], ['events', 'p', '--seconds', '61'],
    ['pets', '--studio-url', 'https://user:secret@example.com'],
    ['pets', '--agent-url', 'http://localhost/path'],
  ]) assert.throws(() => parseStudioOperatorArgs(args));
  for (const args of [[], ['start'], ['init'], ['tmux'], ['console']]) {
    assert.equal(parseStudioOperatorArgs(args), null);
  }
});

test('operator commands send the existing wire protocol without retries or starting a Host', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-operator-test-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'test-local-authority\n');
  await writeFile(join(dir, 'body.md'), '**Hello**\n\n```text\n@label\n```');
  await writeFile(join(dir, 'resume.json'), JSON.stringify({ type: 'interrupt.resume', requestId: 'r', interruptId: 'i', value: {} }));
  const seen: { method: string; url: string; body?: Record<string, unknown>; auth?: string }[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    seen.push({ method: request.method!, url: request.url!, auth: request.headers.authorization,
      ...(text ? { body: JSON.parse(text) } : {}) });
    if (request.url?.endsWith('/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = Buffer.from('event: message\r\ndata: {"type":"message.delta","text":"中文🙂"}\r\n\r\n');
      response.write(event.subarray(0, event.length - 9));
      response.write(event.subarray(event.length - 9));
      request.on('close', () => response.end());
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/channels/messages' && seen.at(-1)?.body?.channelId === 'failed') {
      response.writeHead(409);
      response.end(JSON.stringify({ error: 'Unknown participant test-local-authority' }));
    } else if (request.url?.endsWith('/snapshot')) {
      response.end(JSON.stringify({ queue: { state: 'idle' }, snapshot: { session: {
        sessionId: 's', activeRun: null, pendingInterrupt: null,
        timeline: Array.from({ length: 6 }, (_, n) => ({ id: n })),
      } } }));
    } else response.end(JSON.stringify({ accepted: true, nextAfter: 7, hasMore: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const connection = ['--studio-url', url, '--agent-url', url, '--token-file', tokenFile];
  let output = '';
  async function run(args: string[]) {
    output = '';
    await runStudioHostCli([...connection, ...args], {
      runHost: () => assert.fail('operator command started a Host'),
      writeOutput: (text) => { output += text; },
    });
  }
  for (const [args, path] of [
    [['channels', 'list', '--after', '2', '--limit', '3'], '/channels?after=2&limit=3'],
    [['channels', 'participants'], '/channels/participants'],
    [['channels', 'read', 'c a'], '/channels/context?channelId=c+a'],
    [['channels', 'executions', 'c'], '/channels/executions?channelId=c'],
    [['channels', 'interrupts', 'c'], '/channels/interrupts?channelId=c'],
    [['pets'], '/pets'], [['queues'], '/dispatch/queues'],
  ] as [string[], string][]) {
    await run(args);
    assert.equal(seen.at(-1)?.url, path);
    assert.equal(seen.at(-1)?.method, 'GET');
    assert.equal(seen.at(-1)?.auth, 'Bearer test-local-authority');
    assert.deepEqual(JSON.parse(output), { accepted: true, nextAfter: 7, hasMore: true });
  }
  await run(['channels', 'send', 'c', '--file', join(dir, 'body.md'), '--mention', 'pet:reviewer', '--mention', 'pet:reviewer', '--mention', 'human:operator', '--reply-to', 'original']);
  assert.deepEqual(seen.at(-1)?.body, { channelId: 'c', body: '**Hello**\n\n```text\n@label\n```',
    mentions: [{ participantId: 'pet:reviewer' }, { participantId: 'human:operator' }], replyTo: 'original' });
  assert.equal(seen.at(-1)?.method, 'POST');
  await run(['dispatch', 'executor', '--file', join(dir, 'body.md'), '--idempotency-key', 'stable-key']);
  assert.equal(seen.at(-1)?.body?.idempotencyKey, 'stable-key');
  assert.equal(seen.at(-1)?.body?.petId, 'executor');
  await run(['send', 'executor', '--file', join(dir, 'resume.json')]);
  assert.equal(seen.at(-1)?.url, '/agent-session/pets/executor/messages');
  assert.equal(seen.at(-1)?.body?.interruptId, 'i');
  await run(['snapshot', 'pet space']);
  assert.equal(seen.at(-1)?.url, '/agent-session/pets/pet%20space/snapshot');
  assert.equal(JSON.parse(output).recentTimeline.length, 4);
  await run(['snapshot', 'pet space', '--full']);
  assert.equal(JSON.parse(output).snapshot.session.timeline.length, 6);
  await run(['events', 'executor', '--seconds', '1']);
  assert.deepEqual(JSON.parse(output), { type: 'message.delta', text: '中文🙂' });
  const count = seen.length;
  await assert.rejects(run(['channels', 'send', 'failed', '--file', join(dir, 'body.md')]), error => {
    assert.match(String(error), /HTTP 409/);
    assert.match(String(error), /not retried/);
    assert.doesNotMatch(String(error), /test-local-authority/);
    return true;
  });
  assert.equal(seen.length, count + 1);
});

test('stdin, token errors, JSON validation and operational help do not expose credentials', async () => {
  let fetched = 0;
  let output = '';
  const dependencies = {
    readText: async () => 'secret-token', readStdin: async () => 'stdin **message**',
    fetch: (async (_url, init) => {
      fetched += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), { channelId: 'c', body: 'stdin **message**', mentions: [] });
      return Response.json({ messageId: 'saved' });
    }) as typeof fetch,
    writeOutput: (text: string) => { output += text; },
  };
  await runStudioOperator(parseStudioOperatorArgs(['channels', 'send', 'c', '--file', '-'])!, dependencies);
  assert.equal(fetched, 1);
  assert.equal(JSON.parse(output).messageId, 'saved');
  await assert.rejects(runStudioOperator(parseStudioOperatorArgs(['send', 'p', '--file', '-'])!, dependencies), /JSON/);
  assert.equal(fetched, 1);
  await assert.rejects(runStudioOperator(parseStudioOperatorArgs(['pets'])!, {
    ...dependencies, readText: async () => { throw new Error('secret-token'); },
  }), /token is unavailable/);
  assert.equal(fetched, 1);
  await runStudioHostCli(['channels', '--help'], { runHost: () => assert.fail('started Host'), writeOutput: () => {} });
});

test('Studio and Agent Session origins remain separate and network mutations are not retried', async () => {
  const options = ['--studio-url', 'http://localhost:3291', '--agent-url', 'http://localhost:3292'];
  const routes: string[] = [];
  const dependencies = {
    readText: async () => 'token-value',
    writeOutput: () => {},
    fetch: (async (url, init) => {
      routes.push(String(url));
      assert.equal(init?.redirect, 'error');
      return Response.json(String(url).includes('snapshot') ? { snapshot: { session: { timeline: [] } } } : {});
    }) as typeof fetch,
  };
  await runStudioOperator(parseStudioOperatorArgs([...options, 'pets'])!, dependencies);
  await runStudioOperator(parseStudioOperatorArgs([...options, 'snapshot', 'p'])!, dependencies);
  assert.deepEqual(routes, ['http://localhost:3291/pets', 'http://localhost:3292/agent-session/pets/p/snapshot']);
  let attempts = 0;
  await assert.rejects(runStudioOperator(parseStudioOperatorArgs(['channels', 'send', 'c', '--file', '-'])!, {
    ...dependencies, readStdin: async () => 'request',
    fetch: (async () => { attempts += 1; throw new Error('connection lost token-value'); }) as typeof fetch,
  }), error => {
    assert.match(String(error), /not retried/);
    assert.doesNotMatch(String(error), /token-value/);
    return true;
  });
  assert.equal(attempts, 1);
});
