import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { markToolResultAttachment } from './metadata';
import { makeToolProtocolSafe } from './protocol';

function calls() {
  return new AIMessage({ id: 'calls', content: '', tool_calls: [
    { id: 'read-a', name: 'read_file', args: { path: 'a.pdf' } },
    { id: 'read-b', name: 'read_file', args: { path: 'b.png' } },
  ] });
}

function receipt(id: string) {
  return new ToolMessage({ id: `receipt:${id}`, content: 'Read.', tool_call_id: id });
}

function attachment(id: string) {
  return markToolResultAttachment(new HumanMessage({ id: `attachment:${id}`,
    content: [{ type: 'file', mimeType: 'application/pdf', data: 'JVBERi0=' }],
    additional_kwargs: { pinpawo: { source: 'fixture' }, marker: 'retained' },
  }), id);
}

test('parallel attachments follow all receipts in model input without changing canonical history', () => {
  const history = [calls(), receipt('read-a'), attachment('read-a'), receipt('read-b'), attachment('read-b')];
  const before = history.map(message => message.toDict());
  const safe = makeToolProtocolSafe(Object.freeze(history));
  assert.deepEqual(safe.messages.map(message => message.id),
    ['calls', 'receipt:read-a', 'receipt:read-b', 'attachment:read-a', 'attachment:read-b']);
  assert.deepEqual(safe.removedMessageIds, []);
  assert.deepEqual(history.map(message => message.toDict()), before);
  assert.strictEqual(safe.messages[3], history[2]);
  assert.deepEqual(history[2].additional_kwargs, {
    pinpawo: { source: 'fixture', toolResultAttachmentCallId: 'read-a' }, marker: 'retained',
  });
});

test('missing receipts discard their incomplete call group and linked attachments', () => {
  const history = [calls(), receipt('read-a'), attachment('read-a'), new HumanMessage({ id: 'user', content: 'Continue.' })];
  const safe = makeToolProtocolSafe(history);
  assert.deepEqual(safe.messages.map(message => message.id), ['user']);
  assert.deepEqual(safe.removedMessageIds, ['calls', 'receipt:read-a', 'attachment:read-a']);
});

test('unmarked user turns are not reordered across parallel tool results', () => {
  const user = new HumanMessage({ id: 'user', content: 'An actual new user turn.' });
  const safe = makeToolProtocolSafe([calls(), receipt('read-a'), user, receipt('read-b'), attachment('read-b')]);
  assert.deepEqual(safe.messages, [user]);
  assert.deepEqual(safe.removedMessageIds, ['calls', 'receipt:read-a', 'receipt:read-b', 'attachment:read-b']);
});

test('orphan, malformed and not-yet-receipted attachment markers never reach the model', () => {
  const orphan = attachment('other-call');
  const malformed = new HumanMessage({ id: 'malformed', content: 'Invalid attachment marker.',
    additional_kwargs: { pinpawo: { toolResultAttachmentCallId: 123 } } });
  assert.deepEqual(makeToolProtocolSafe([orphan, malformed]).messages, []);
  const safe = makeToolProtocolSafe([calls(), receipt('read-a'), attachment('read-b'), receipt('read-b')]);
  assert.deepEqual(safe.messages, []);
  const foreign = makeToolProtocolSafe([calls(), receipt('read-a'), receipt('read-b'), orphan]);
  assert.deepEqual(foreign.messages.map(message => message.id), ['calls', 'receipt:read-a', 'receipt:read-b']);
  assert.deepEqual(foreign.removedMessageIds, ['attachment:other-call']);
  assert.throws(() => markToolResultAttachment(new HumanMessage('file'), ' '), /nonblank/);
});
