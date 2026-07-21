import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromeExtensionBrowserSession } from './session';

const rawSnapshot = {
  title: 'Example',
  url: 'https://example.com/page',
  text: 'Readable page',
  interactive: [{
    index: 1,
    tag: 'button',
    text: 'Continue',
    type: null,
    placeholder: null,
    hint: 'button',
  }],
  interactiveCount: 1,
};

test('extension session uses one approved origin and the shared payload builder', async () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const session = new ChromeExtensionBrowserSession({
    async sendCommand(command, params) {
      calls.push({ command, params });
      if (command === 'detach') return { detached: true };
      return rawSnapshot;
    },
  });

  const opened = JSON.parse(await session.open('https://example.com/page')) as {
    text: string;
    interactive: Array<{ hint: string }>;
  };
  assert.equal(opened.text, 'Readable page');
  assert.equal(opened.interactive[0]?.hint, '[1] button');
  assert.deepEqual(calls[0], {
    command: 'navigate',
    params: { url: 'https://example.com/page', approvedOrigin: 'https://example.com' },
  });

  await session.snapshot();
  assert.deepEqual(calls[1], {
    command: 'snapshot',
    params: { approvedOrigin: 'https://example.com' },
  });
  await session.close();
  assert.equal(calls[2]?.command, 'detach');
});

test('extension session rejects unsupported modes and operations explicitly', async () => {
  const session = new ChromeExtensionBrowserSession({
    async sendCommand() {
      return rawSnapshot;
    },
  });
  await assert.rejects(session.open('file:///tmp/page.html'), /only supports http/);
  await assert.rejects(session.open('https://example.com', { headless: true }), /does not support headless/);
  await assert.rejects(session.click('#submit'), /does not support click/);
});
