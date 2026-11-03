import assert from 'node:assert/strict';
import test from 'node:test';
import { messageDisplayReferences } from './artifactReferences';

test('body-only Markdown and bare artifact links resolve without becoming saved deliverables', () => {
  const uri = 'artifact://workspace/session/id/report(part).txt';
  const bare = 'artifact://workspace/session/id/plain.txt';
  const entry = { text: `[Report](<${uri}>) and (${bare}).\n\n\`${bare}/private\`\n\n\`\`\`\n${bare}/code\n\`\`\`` };
  const before = JSON.stringify(entry);
  assert.deepEqual(messageDisplayReferences(entry), [{ uri, title: 'Report' }, { uri: bare }]);
  assert.equal(JSON.stringify(entry), before);
});

test('body display deduplicates structured references and preserves their title and ordinary links', () => {
  const uri = 'artifact://workspace/session/id/report.txt';
  const entry = { text: `[A second label](${uri}) and ${uri}`, deliverables: [
    { uri, title: 'Published report' }, { uri: 'https://example.com/pull/1' },
  ] };
  assert.deepEqual(messageDisplayReferences(entry), entry.deliverables);
  assert.deepEqual(messageDisplayReferences({ text: '[bad](artifact://workspace/../file)' }), []);
});

test('bare published names retain apostrophes and exclamation marks', () => {
  for (const name of ["owner's%2Etxt", 'report!', 'report(part)%2Etxt']) {
    const uri = `artifact://workspace/session/id/${name}`;
    assert.deepEqual(messageDisplayReferences({ text: uri }), [{ uri }]);
  }
});
