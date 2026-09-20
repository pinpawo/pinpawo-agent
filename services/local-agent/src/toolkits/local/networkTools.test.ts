import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import {
  htmlToText,
  httpFetchTool,
  inferFilename,
  sanitizeFilename,
  normalizeHttpFetchAuthorizationInput,
} from './networkTools';
import { createBashToolkit } from './index';

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

test('network tool helpers sanitize names and infer image extensions', () => {
  assert.equal(sanitizeFilename('a/b:c?.png'), 'a_b_c_.png');
  assert.equal(inferFilename('https://example.test/assets/photo', null, 'image/png'), 'photo.png');
  assert.equal(inferFilename('https://example.test/assets/report.pdf'), 'report.pdf');
  assert.equal(inferFilename('https://example.test/assets/photo.jpg', 'avatar?.jpg'), 'avatar_.jpg');
});

test('htmlToText strips markup and decodes common entities', () => {
  assert.equal(
    htmlToText('<main><h1>Hello&nbsp;World</h1><script>bad()</script><p>A&amp;B<br>Done</p></main>'),
    'Hello World\nA&B\nDone',
  );
});

test('httpFetchTool uses mocked fetch and returns readable text', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string> | undefined)?.Accept, 'text/html,application/json,*/*');
    return new Response('<main><p>Hello<br>World</p></main>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });

  assert.equal(
    await httpFetchTool.invoke({
      url: 'https://example.test/page',
      method: 'POST',
      body: 'ok',
    }),
    'Hello\nWorld',
  );
});

test('bash toolkit external access policy reviews configured network calls', async () => {
  const toolkit = createBashToolkit();
  const httpPolicy = definition(toolkit, 'http_fetch')?.review;
  const downloadPolicy = definition(toolkit, 'download_file')?.review;
  assert.ok(httpPolicy);
  assert.ok(downloadPolicy);

  const baseContext = {
    models: {} as never,
    messages: [],
    toolkitName: 'bash',
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  };

  const getContext = {
    ...baseContext,
    toolName: 'http_fetch',
    input: { url: 'https://example.test/page' },
    operation: definition(toolkit, 'http_fetch')?.operation,
  };
  const buildHttpMatcher = httpPolicy.authorization?.buildMatcher;
  assert.ok(buildHttpMatcher);
  const getReview = await httpPolicy.request({
    ...getContext,
    authorizationMatcher: await buildHttpMatcher(getContext),
  });
  assert.equal(getReview && 'schemaVersion' in getReview ? getReview.view.title : null, '请求网页');
  assert.deepEqual(
    getReview && 'schemaVersion' in getReview ? getReview.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );

  const postContext = {
    ...baseContext,
    toolName: 'http_fetch',
    input: { url: 'https://example.test/page', method: 'POST', body: 'ok' },
    operation: definition(toolkit, 'http_fetch')?.operation,
  };
  const postReview = await httpPolicy.request({
    ...postContext,
    authorizationMatcher: await buildHttpMatcher(postContext),
  });
  assert.equal(postReview && 'schemaVersion' in postReview ? postReview.view.title : null, '请求网页');

  const downloadContext = {
    ...baseContext,
    toolName: 'download_file',
    input: { url: 'https://example.test/file.txt' },
    operation: definition(toolkit, 'download_file')?.operation,
  };
  const buildDownloadMatcher = downloadPolicy.authorization?.buildMatcher;
  assert.ok(buildDownloadMatcher);
  const downloadReview = await downloadPolicy.request({
    ...downloadContext,
    authorizationMatcher: await buildDownloadMatcher(downloadContext),
  });
  assert.equal(downloadReview && 'schemaVersion' in downloadReview ? downloadReview.view.title : null, '下载文件');
  assert.deepEqual(
    downloadReview && 'schemaVersion' in downloadReview ? downloadReview.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});

test('http_fetch authorization covers an origin but not a new method', () => {
  const key = (input: unknown) => JSON.stringify(
    normalizeHttpFetchAuthorizationInput(input),
  );
  // One approval should cover the rest of the host: re-reviewing every path is
  // what pushed models to the unreviewed browser toolkit instead.
  assert.equal(
    key({ url: 'https://weather.com.cn/ningbo' }),
    key({ url: 'https://weather.com.cn/hangzhou?day=1' }),
  );
  // A grant must not carry a request body it never saw.
  assert.notEqual(
    key({ url: 'https://api.example.com/v1', method: 'GET' }),
    key({ url: 'https://api.example.com/v1', method: 'POST' }),
  );
  assert.notEqual(
    key({ url: 'https://weather.com.cn/ningbo' }),
    key({ url: 'https://evil.example/ningbo' }),
  );
  // Unparsable URLs must stay distinct rather than share one key.
  assert.notEqual(key({ url: 'not-a-url' }), key({ url: 'also-bad' }));
});
