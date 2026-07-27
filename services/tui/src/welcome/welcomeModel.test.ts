import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import stringWidth from 'string-width';
import type { AgentSession } from '@pinpawo/agent-session';
import { TUI_VERSION } from '../version';
import { buildWelcomeLines } from './welcomeModel';

const SESSION: AgentSession = {
  sessionId: 'chat:one',
  kind: 'chat',
  actor: {
    label: '豆包',
    summary: 'Local helper',
  },
  runtime: {
    model: 'gpt-test',
    cwd: '/Users/mac/Develop/pinpawo-agent',
  },
  timeline: [],
  activeRun: null,
};

test('welcome includes the raster paw, version, runtime, and shortcuts', () => {
  const lines = buildWelcomeLines({
    session: SESSION,
    width: 80,
    connection: 'connected',
  });
  assert.deepEqual(lines.slice(0, 7), [
    '   ▄█▄ ▄█▄   ',
    '   ███ ███   ',
    '▄█▄ ▀   ▀ ▄█▄',
    '██▀ ▄███▄ ▀██',
    '  ▄███████▄  ',
    ' ███████████ ',
    '  ▀███▀███▀  ',
  ]);
  assert.match(lines[7] ?? '', /PinPawo TUI v2 · v0\.1\.0 · 豆包/);
  assert.ok(lines.some((line) => line.includes('/resume')));
});

test('welcome remains single-row safe in a narrow terminal', () => {
  const lines = buildWelcomeLines({
    session: SESSION,
    width: 24,
    connection: 'reconnecting in 5s',
  });
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 24, line);
    assert.doesNotMatch(line, /[\r\n]/);
  }
});

test('displayed TUI version matches the workspace package', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  assert.equal(TUI_VERSION, packageJson.version);
});
