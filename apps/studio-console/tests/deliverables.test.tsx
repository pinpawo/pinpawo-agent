import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelMessageMarkdown, ChannelTimeline } from '../src/ChannelConversation';
import { MessageDeliverables, readArtifactBlob } from '../src/MessageDeliverables';
import { PetSessionTranscript } from '../src/PetSessionView';

const uri = 'artifact://workspace/thread/file/report.md';
const deliverables = [{ uri, title: 'Report' }, { uri: 'https://github.com/pinpawo/pinpawo-agent/pull/1', title: 'Pull request' }];
const source = { url: 'https://studio.example', token: 'private-token' };

test('message links expose structured deliverables and route artifact Markdown without exposing credentials', () => {
  const html = renderToStaticMarkup(<><MessageDeliverables deliverables={deliverables} source={source} />
    <ChannelMessageMarkdown body={`[Report](${uri}) [unsafe](javascript:alert)`} members={[]} artifactSource={source} /></>);
  assert.ok(html.includes(`https://studio.example/agent-session/artifacts?uri=${encodeURIComponent(uri)}`));
  assert.ok(html.includes('href="https://github.com/pinpawo/pinpawo-agent/pull/1"'));
  assert.ok(html.includes('Report'));
  assert.ok(!html.includes('private-token'));
  assert.ok(!html.includes('javascript:'));
});

test('Channel and Pet session messages display declared links even when prose omits them', () => {
  const channel = renderToStaticMarkup(<ChannelTimeline messages={[{
    sequence: 1, messageId: 'm', channelId: 'c', author: { kind: 'pet', id: 'p' },
    occurredAt: '2026-11-05T00:00:00Z', body: 'Done.', mentions: [], deliverables,
  }]} pending={false} onReply={() => undefined} artifactSource={source} />);
  const session = renderToStaticMarkup(<PetSessionTranscript petName="Pet" artifactSource={source} session={{
    sessionId: 's', kind: 'chat', activeRun: null, timeline: [{
      type: 'message', id: 'reply', role: 'assistant', text: 'Done.', status: 'completed', deliverables,
    }],
  }} />);
  for (const html of [channel, session]) {
    assert.ok(html.includes('aria-label="Deliverables"'));
    assert.ok(html.includes('Pull request'));
    assert.ok(!html.includes('private-token'));
  }
});

test('artifact fetch authenticates with a header and reports HTTP failures', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response('report', { status: 200 });
  };
  try {
    assert.equal(await (await readArtifactBlob(uri, source)).text(), 'report');
    assert.deepEqual(requests, [{ url: `${source.url}/agent-session/artifacts?uri=${encodeURIComponent(uri)}`,
      init: { headers: { Authorization: 'Bearer private-token' } } }]);
    globalThis.fetch = async () => new Response('denied', { status: 403 });
    await assert.rejects(readArtifactBlob(uri, source), /403/);
  } finally {
    globalThis.fetch = original;
  }
});
