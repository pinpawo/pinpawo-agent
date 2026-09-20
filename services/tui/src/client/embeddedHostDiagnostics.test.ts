import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEmbeddedHostDiagnosticsSink } from './embeddedHostDiagnostics';

test('embedded host diagnostics append timestamped lines to the log file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pinpawo-embedded-host-log-'));
  const path = join(directory, 'nested', 'embedded-host.log');
  try {
    const sink = createEmbeddedHostDiagnosticsSink(path);
    sink('[local-server] stdio JSONL transport ready');
    sink('[local-agent] stopping');

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(
        line,
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[local-(server|agent)\]/,
      );
    }
    assert.equal(
      lines[0]?.endsWith('[local-server] stdio JSONL transport ready'),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('embedded host diagnostics stay silent when the log cannot be written', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pinpawo-embedded-host-log-'));
  const blocked = join(directory, 'file');
  try {
    // A path whose parent is a file can never be appended to; diagnostics must
    // degrade to a no-op instead of failing the terminal UI.
    writeFileSync(blocked, 'not a directory\n');
    const sink = createEmbeddedHostDiagnosticsSink(join(blocked, 'log'));
    assert.doesNotThrow(() => sink('[local-agent] first'));
    assert.doesNotThrow(() => sink('[local-agent] second'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
