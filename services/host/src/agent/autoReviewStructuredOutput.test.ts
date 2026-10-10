import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatOpenAI } from '@langchain/openai';
import { buildReviewSpec, createAutoReviewer } from '@pinpawo/pet-agent';

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
