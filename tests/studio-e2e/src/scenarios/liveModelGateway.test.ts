import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createLiveScenarioGateway, type LiveScenarioGatewayOptions } from './liveModelGateway';

const providerKey = 'unit-test-provider-credential';
const model = 'synthetic-model';
const completion = { id: 'fixture', object: 'chat.completion', choices: [{ index: 0,
  message: { role: 'assistant', content: 'Synthetic result.' }, finish_reason: 'stop' }] };
const request = () => ({ model, messages: [{ role: 'user', content: 'Read the synthetic cobalt record.' }] });
const lookup = () => ({ type: 'function', function: { name: 'synthetic_lookup', description: 'Read synthetic data.',
  parameters: { type: 'object', properties: { recordId: { type: 'string', const: 'cobalt' } }, required: ['recordId'],
    additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' } } });
const asFetch = (transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => transport as typeof fetch;
async function gateway(t: TestContext, transport: typeof fetch, options: Partial<LiveScenarioGatewayOptions> = {}) {
  const value = await createLiveScenarioGateway({ baseUrl: 'https://provider.invalid/v1/', model,
    apiKey: providerKey, forbiddenRoots: ['/private/repository'], fetch: transport, ...options });
  t.after(() => value.close());
  return value;
}
async function post(value: Awaited<ReturnType<typeof createLiveScenarioGateway>>, body: unknown, signal?: AbortSignal) {
  return fetch(`${value.baseUrl}/chat/completions`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${value.apiKey}`, 'x-private-header': 'local-only' },
    body: JSON.stringify(body) });
}
const chunk = (text: string) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;

test('live gateway virtualizes every local path and sends the provider key only in Authorization', async t => {
  let outgoing = '';
  let target = '';
  let headers: Headers | undefined;
  let redirect: RequestRedirect | undefined;
  const value = await gateway(t, asFetch(async (input, init) => {
    target = String(input); outgoing = String(init?.body); headers = new Headers(init?.headers); redirect = init?.redirect;
    return Response.json(completion);
  }));
  const paths = ['/private/repository/docs/secret.txt', '/Users/private-person/project/file', '/home/private-user/data',
    '/tmp/private-run/file', '/var/folders/private-run/file', '/opt/private-location/file',
    'C:\\Users\\private-user\\file.txt', '\\\\private-server\\private-share\\file.txt'];
  const body = { ...request(), tools: [lookup()], messages: [
    { role: 'system', content: paths.map(path => `Working directory: ${path}`).join('\n') },
    { role: 'user', content: JSON.stringify({ nested: JSON.stringify({ path: paths[1], windows: paths[6] }),
      encoded: '%2Fhome%2Fprivate-user%2Fdata', unicode: '\\u002fUsers\\u002fprivate-person\\u002fdata' }) },
    { role: 'assistant', content: null, reasoning_content: `Working directory: ${paths[5]}` },
  ] };
  const response = await post(value, body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completion);
  for (const path of paths) assert.equal(outgoing.includes(path), false);
  for (const privatePart of ['private-person', 'private-user', 'private-server', 'private-location', 'repository', 'private-run']) {
    assert.equal(outgoing.includes(privatePart), false);
  }
  assert.match(outgoing, /\/scenario/);
  assert.equal(outgoing.includes(providerKey), false);
  assert.equal(outgoing.includes('http:'), false, 'schema dialect metadata is stripped');
  assert.equal(target, 'https://provider.invalid/v1/chat/completions');
  assert.equal(redirect, 'error');
  assert.equal(headers?.get('authorization'), `Bearer ${providerKey}`);
  assert.equal(headers?.get('x-private-header'), null);
  assert.equal([...headers!.keys()].length, 2);
  assert.equal(JSON.stringify(value).includes(providerKey), false);
  assert.equal(value.stats.forwarded, 1);
  assert.ok(value.stats.redactions >= paths.length);
});

test('unknown tools, unsafe schemas, images, attachments, URLs and encoded credentials fail closed', async t => {
  let forwarded = 0;
  const value = await gateway(t, asFetch(async () => { forwarded++; return Response.json(completion); }));
  const badTool = (name: string) => ({ ...lookup(), function: { ...lookup().function, name } });
  const unsafeSchema = lookup();
  unsafeSchema.function.parameters.properties = { command: { type: 'string', const: 'cobalt' } } as never;
  const cases: unknown[] = [
    ...['run_shell', 'read_file', 'http_get', 'browser', 'transfer_to_parent', 'unknown_tool'].map(name => ({ ...request(), tools: [badTool(name)] })),
    { ...request(), tools: [unsafeSchema] },
    { ...request(), tools: [{ ...lookup(), function: { ...lookup().function,
      parameters: { type: 'object', $ref: 'https://private.invalid/schema' } } }] },
    { model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.invalid/image' } }] }] },
    { ...request(), attachments: [{ file_id: 'private-file' }] },
    ...['https://private.invalid/data', 'data:image/png;base64,AAAA', 'file:///Users/private/data', '%68ttps%3A%2F%2Fprivate.invalid'].map(content =>
      ({ model, messages: [{ role: 'user', content }] })),
    ...[providerKey, 'sk-abcdefghijklmnopqrstuvwxyz123456', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123456789',
      JSON.stringify({ nested: JSON.stringify({ value: providerKey.replace('u', '\\u0075') }) })].map(content =>
      ({ model, messages: [{ role: 'user', content }] })),
    { model, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function',
      function: { name: 'plan_request', arguments: '{"goal":"\\u0075nit-test-provider-credential"}' } }] }] },
  ];
  for (const body of cases) {
    const response = await post(value, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'scenario_gateway_blocked');
  }
  assert.equal(forwarded, 0);
  assert.equal(value.stats.blocked, cases.length);
});

test('the complete synthetic runtime tool surface and text-only history remain usable', async t => {
  const value = await gateway(t, asFetch(async () => Response.json(completion)));
  const fields: Record<string, string[]> = { plan_request: ['goal'], continue: ['goal'], capability_details: ['names'],
    submit_plan: ['tasks'], adjust_plan: ['adjustedGoal', 'reason', 'currentTask', 'tasks'], review_current: ['completed', 'reason'],
    delegate_capability: ['briefing'], runtime_budget_status: [] };
  const tools = Object.entries(fields).map(([name, keys]) => ({ type: 'function', function: { name, parameters: {
    type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])), additionalProperties: false,
  } } }));
  const response = await post(value, { ...request(), tools: [...tools, lookup()], response_format: { type: 'json_object' }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Read synthetic cobalt.' }] },
    { role: 'assistant', content: null, reasoning_content: 'Use the supplied synthetic tool.', tool_calls: [{ id: 'call', type: 'function',
      function: { name: 'synthetic_lookup', arguments: '{"recordId":"cobalt"}' } }] },
    { role: 'tool', name: 'synthetic_lookup', tool_call_id: 'call', content: '{"recordId":"cobalt","units":7,"receipt":"synthetic-receipt"}' },
  ] });
  assert.equal(response.status, 200);
});

test('provider errors, redirects and transport exceptions expose only fixed codes', async t => {
  const sensitive = `${providerKey} /Users/private-person/data https://private.invalid`;
  const responses = [
    () => new Response(sensitive, { status: 401 }),
    () => new Response(sensitive, { status: 302, headers: { location: 'https://redirect.invalid' } }),
    () => Response.json({ error: { message: sensitive } }),
    () => Response.json({ ...completion, choices: [{ index: 0, message: { role: 'assistant', content: 'ok', error: sensitive } }] }),
    () => Response.json({ ...completion, private_metadata: sensitive }),
    () => { throw new Error(sensitive); },
  ];
  for (const respond of responses) {
    const value = await gateway(t, asFetch(async () => respond()));
    const response = await post(value, request());
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.includes(providerKey), false);
    assert.equal(text.includes('private-person'), false);
    assert.equal(JSON.parse(text).error.code, 'scenario_gateway_upstream');
  }
});

test('valid UTF-8 SSE, tool-call deltas and usage survive arbitrary transport chunks', async t => {
  const toolChunk = (delta: unknown) => `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
  const stream = chunk('合成 ') + toolChunk({ tool_calls: [{ index: 0, id: 'call', type: 'function',
    function: { name: 'synthetic_', arguments: '' } }] }) + toolChunk({ tool_calls: [{ index: 0,
    function: { name: 'lookup', arguments: '{"recordId":"cobalt"}' } }] })
    + 'data: {"choices":[],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(stream);
  const value = await gateway(t, asFetch(async () => new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } })));
  const response = await post(value, { ...request(), stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(await response.text(), stream);
});

test('JSON escapes and credentials split across SSE deltas never reach the local client', async t => {
  const encoded = JSON.stringify({ ...completion, choices: [{ index: 0,
    message: { role: 'assistant', content: providerKey } }] }).replace(providerKey, '\\u0075' + providerKey.slice(1));
  for (const [body, stream] of [[encoded, false], [chunk(providerKey.slice(0, 8)) + chunk(providerKey.slice(8)) + 'data: [DONE]\n\n', true],
    [chunk('Safe prefix.') + `event: error\ndata: ${JSON.stringify({ error: { message: providerKey } })}\n\n`, true]] as const) {
    const value = await gateway(t, asFetch(async () => new Response(body)));
    const response = await post(value, { ...request(), stream });
    const text = await response.text();
    assert.equal(response.status, 502);
    assert.equal(text.includes(providerKey.slice(0, 8)), false);
    assert.equal(text.includes('Safe prefix.'), false, 'no part of a rejected stream is released');
    assert.equal(JSON.parse(text).error.code, 'scenario_gateway_upstream');
  }
});

test('request and response bodies have fixed bounds', async t => {
  let forwarded = 0;
  const value = await gateway(t, asFetch(async () => { forwarded++; return new Response('x'.repeat(8 * 1024 * 1024 + 1)); }));
  const tooLarge = await post(value, { model, messages: [{ role: 'user', content: 'x'.repeat(512 * 1024) }] });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'scenario_gateway_request_too_large');
  assert.equal(forwarded, 0);
  const response = await post(value, request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'scenario_gateway_response_too_large');
});

test('timeout aborts upstream work and does not expose the abort error', async t => {
  let aborted = false;
  const value = await gateway(t, asFetch(async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error(providerKey)); }, { once: true });
  })), { timeoutMs: 30 });
  const response = await post(value, request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'scenario_gateway_timeout');
  assert.equal(aborted, true);
});

test('client abort and idempotent close cancel active upstream requests and response streams', async t => {
  let entered!: () => void;
  let aborted!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const value = await gateway(t, asFetch(async (_input, init) => {
    init!.signal!.addEventListener('abort', aborted, { once: true });
    entered();
    return new Response(new ReadableStream({ cancel() { aborted(); } }));
  }));
  const controller = new AbortController();
  const response = post(value, request(), controller.signal).catch(() => undefined);
  await started;
  controller.abort();
  await cancelled;
  await response;
  await Promise.all([value.close(), value.close()]);

  let closeEntered!: () => void;
  let closeAborted!: () => void;
  const closeStarted = new Promise<void>(resolve => { closeEntered = resolve; });
  const closeCancelled = new Promise<void>(resolve => { closeAborted = resolve; });
  const closing = await gateway(t, asFetch(async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { closeAborted(); reject(new Error(providerKey)); }, { once: true });
    closeEntered();
  })));
  const pending = post(closing, request()).catch(() => undefined);
  await closeStarted;
  await Promise.all([closing.close(), closing.close(), closeCancelled]);
  await pending;
});

test('only an explicit HTTPS endpoint without embedded credentials can be configured', async () => {
  for (const baseUrl of ['http://provider.invalid/v1', 'https://user:secret@provider.invalid',
    'https://provider.invalid/v1?key=secret', 'https://provider.invalid/v1#secret', `https://provider.invalid/${providerKey}`]) {
    await assert.rejects(createLiveScenarioGateway({ baseUrl, model, apiKey: providerKey, forbiddenRoots: [] }),
      { message: 'scenario_gateway_invalid_configuration' });
  }
});

test('production Pet Head prompts and tool schemas pass the gateway in a fully offline trial', { timeout: 30_000 }, async t => {
  const { createDeterministicScenarioModel, runPetHeadTimelineTrial } = await import('./petHeadTimeline');
  const fixture = await createDeterministicScenarioModel();
  t.after(() => fixture.close());
  const value = await gateway(t, asFetch(async (_input, init) => fetch(`${fixture.baseUrl}/chat/completions`, init)),
    { model: fixture.model });
  const result = await runPetHeadTimelineTrial({ trial: 1, model: value });
  assert.deepEqual(result.cases.map(item => ({ id: item.id, status: item.status })), [
    { id: 'first-tool-call', status: 'passed' },
    { id: 'referenced-follow-up', status: 'passed' },
    { id: 'cross-channel-head-isolation', status: 'passed' },
  ]);
  assert.equal(value.stats.blocked, 0);
  assert.ok(value.stats.forwarded > 0);
  assert.ok(value.stats.redactions > 0, 'the production Host working directory was virtualized');
});
