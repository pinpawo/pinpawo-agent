import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import {
  htmlToText,
  httpFetchTool,
  inferFilename,
  sanitizeFilename,
} from './toolkits/local/networkTools';
import { createBashToolkit } from './toolkits/local';

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
    actor: {} as never,
    messages: [],
    toolkitName: 'bash',
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  };

  const getReview = await httpPolicy.request({
    ...baseContext,
    toolName: 'http_fetch',
    input: { url: 'https://example.test/page' },
    operation: definition(toolkit, 'http_fetch')?.operation,
  });
  assert.equal(getReview && 'schemaVersion' in getReview ? getReview.view.title : null, '请求网页');
  assert.deepEqual(
    getReview && 'schemaVersion' in getReview ? getReview.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );

  const postReview = await httpPolicy.request({
    ...baseContext,
    toolName: 'http_fetch',
    input: { url: 'https://example.test/page', method: 'POST', body: 'ok' },
    operation: definition(toolkit, 'http_fetch')?.operation,
  });
  assert.equal(postReview && 'schemaVersion' in postReview ? postReview.view.title : null, '请求网页');

  const downloadReview = await downloadPolicy.request({
    ...baseContext,
    toolName: 'download_file',
    input: { url: 'https://example.test/file.txt' },
    operation: definition(toolkit, 'download_file')?.operation,
  });
  assert.equal(downloadReview && 'schemaVersion' in downloadReview ? downloadReview.view.title : null, '下载文件');
  assert.deepEqual(
    downloadReview && 'schemaVersion' in downloadReview ? downloadReview.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});
