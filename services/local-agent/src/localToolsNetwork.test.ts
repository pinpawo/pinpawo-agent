import assert from 'node:assert/strict';
import test from 'node:test';
import {
  htmlToText,
  httpFetchTool,
  inferFilename,
  sanitizeFilename,
} from './toolkits/local/networkTools';

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
