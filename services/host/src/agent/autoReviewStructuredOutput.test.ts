import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatOpenAI } from '@langchain/openai';
import { RunnableLambda } from '@langchain/core/runnables';
import { buildReviewSpec, createAutoReviewer, type StructuredOutputMethod } from '@pinpawo/pet-agent';
import { buildReviewStructuredOutput } from './agentChannel';

// The auto reviewer's schema must survive the OpenAI SDK's strict
// Structured Outputs check, which runs before any request leaves the Host.
// A rejected schema silently routes every review to a human.
test('auto review schema is accepted by strict json_schema structured outputs', async () => {
  const requests: Array<{ response_format?: { json_schema?: { strict?: boolean } } }> = [];
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'kimi-k3',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify({ riskScore: 1, reason: null }) },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const model = new ChatOpenAI({
    model: 'kimi-k3',
    apiKey: 'test',
    maxRetries: 0,
    configuration: { baseURL: 'http://model.test/v1', fetch: fetch as typeof globalThis.fetch },
  });
  const reviewer = createAutoReviewer({
    model,
    structuredOutput: { method: 'jsonSchema', strict: true, autoRepair: false },
  });

  const result = await reviewer.assess({ reviews: [{
    toolkitName: 'shell',
    toolName: 'run_shell',
    input: { command: 'npm test' },
    review: buildReviewSpec({ view: { kind: 'plain', body: 'Run npm test' }, options: [] }),
  }] });

  assert.deepEqual(result, { complete: true, assessment: { riskScore: 1, reason: '' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].response_format?.json_schema?.strict, true);
});

const reviews = [{
  toolkitName: 'shell', toolName: 'run_shell', input: { command: 'npm test' },
  review: buildReviewSpec({ view: { kind: 'plain', body: 'Run npm test' }, options: [] }),
}];

function providerResponse(method: StructuredOutputMethod, result: unknown) {
  return new Response(JSON.stringify({
    id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
    choices: [{ index: 0, finish_reason: method === 'functionCalling' ? 'tool_calls' : 'stop',
      message: method === 'functionCalling'
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'assessment', type: 'function',
          function: { name: 'global_review_policy_auto_assessment', arguments: JSON.stringify(result) } }] }
        : { role: 'assistant', content: JSON.stringify(result) },
    }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

for (const method of ['jsonMode', 'jsonSchema', 'functionCalling'] satisfies StructuredOutputMethod[]) {
  test(`native ChatOpenAI ${method} schema mismatch is repaired with private validation feedback`, async () => {
    const requests: Array<{ messages: unknown[] }> = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return providerResponse(method, requests.length === 1
        ? { riskScore: 'PRIVATE malformed value', reason: 'PRIVATE rejected reason' }
        : { riskScore: 1, reason: null });
    };
    const model = new ChatOpenAI({
      model: 'fixture', apiKey: 'test', maxRetries: 0,
      configuration: { baseURL: 'http://model.test/v1', fetch },
    });
    const reviewer = createAutoReviewer({ model, structuredOutput: { method, ...(method === 'jsonSchema' ? { strict: true } : {}) } });
    let publicModelEvents = 0;
    const result = await RunnableLambda.from(() => reviewer.assess({ reviews })).invoke(undefined, {
      callbacks: [{ handleChatModelStart: () => { publicModelEvents++; }, handleLLMNewToken: () => { publicModelEvents++; } }],
      metadata: { usageScope: 'review' }, signal: new AbortController().signal,
    });
    assert.deepEqual(result, { complete: true, assessment: { riskScore: 1, reason: '' } });
    assert.equal(publicModelEvents, 0, 'private initial and repair calls do not inherit public model callbacks');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.length, requests[0].messages.length + 1);
    assert.equal(JSON.stringify(requests[1]).includes('PRIVATE'), false);
  });
}

test('native model SDK owns recoverable transport retries without schema repair feedback', async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return new Response(JSON.stringify({ error: { message: 'unavailable', type: 'server_error' } }),
      { status: 503, headers: { 'content-type': 'application/json' } });
    return providerResponse('jsonMode', { riskScore: 1, reason: null });
  };
  const model = new ChatOpenAI({ model: 'fixture', apiKey: 'test', maxRetries: 1,
    configuration: { baseURL: 'http://model.test/v1', fetch } });
  assert.deepEqual(await createAutoReviewer({ model, structuredOutput: { method: 'jsonMode' } }).assess({ reviews }),
    { complete: true, assessment: { riskScore: 1, reason: '' } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages, requests[1].messages);
});

for (const status of [401, 503]) {
  test(`native ${status} failures do not multiply exhausted SDK retries with schema repairs`, async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'provider failure', type: 'provider_error' } }),
        { status, headers: { 'content-type': 'application/json' } });
    };
    const model = new ChatOpenAI({ model: 'fixture', apiKey: 'test', maxRetries: 1,
      configuration: { baseURL: 'http://model.test/v1', fetch } });
    await assert.rejects(createAutoReviewer({ model, structuredOutput: {
      method: 'jsonMode', autoRepair: { maxRetries: 3 },
    } }).assess({ reviews }));
    assert.equal(calls, status === 503 ? 2 : 1);
  });
}

test('disabling repair in Host configuration reaches the real reviewer for inferred and default methods', async () => {
  for (const modelName of ['qwen3.7-max', 'gpt-4o']) {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      return providerResponse(request.tools ? 'functionCalling' : 'jsonMode', { riskScore: 'invalid', reason: null });
    };
    const config = { apiKey: 'test', baseUrl: 'http://model.test/v1', model: modelName, structuredOutputAutoRepair: false };
    const model = new ChatOpenAI({ model: modelName, apiKey: 'test', maxRetries: 0,
      configuration: { baseURL: config.baseUrl, fetch } });
    await assert.rejects(createAutoReviewer({ model, structuredOutput: buildReviewStructuredOutput(config) }).assess({ reviews }));
    assert.equal(calls, 1);
  }
});
