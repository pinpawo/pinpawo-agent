import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLegacyToolLogMessage } from './protocol/legacyProtocolAdapter';

test('buildLegacyToolLogMessage derives legacy tool_log from operation events', () => {
  assert.deepEqual(buildLegacyToolLogMessage({
    type: 'operation',
    requestId: 'req-1',
    phase: 'completed',
    operation: {
      id: 'call-1',
      kind: 'file.write',
      title: '写文件',
      source: {
        provider: 'toolkit',
        name: 'write_file',
        callId: 'call-1',
      },
    },
    raw: {
      input: { path: 'a.txt', content: 'hello' },
      output: { ok: true, path: '/tmp/a.txt' },
    },
  }), {
    type: 'tool_log',
    requestId: 'req-1',
    phase: 'end',
    toolName: 'write_file',
    toolCallId: 'call-1',
    input: 'hello',
    output: '{"ok":true,"path":"/tmp/a.txt"}',
    error: undefined,
  });
});
