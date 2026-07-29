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
    hostMetadata: {
      localAgentVersion: '0.2.0',
      capabilities: [
        'general',
        'explore',
        'daily_post',
        'capability_creator',
      ],
    },
  });
  assert.deepEqual(lines.slice(0, 10), [
    '       █████   █████       ',
    '      ███████ ███████          PinPawo TUI v2 · 豆包',
    ' █████ █████   █████ █████     tui v0.1.0 · local-agent v0.2.0',
    '███████             ███████    connected',
    ' █████    ███████    █████     model         gpt-test',
    '        ███████████            directory     /Users/mac/Develop/pinpawo-agent',
    '       █████████████           capabilities  general · explore · daily_post',
    '       █████████████                         capability_creator',
    '        ███████████        ',
    '          ███████          ',
  ]);
  assert.ok(lines.some((line) => line.includes('PinPawo TUI v2')));
  assert.ok(lines.some((line) => line.includes('tui v0.1.0')));
  assert.ok(lines.some((line) => line.includes('local-agent v0.2.0')));
  assert.ok(lines.some((line) => line.includes('capability_creator')));
  assert.ok(lines.some((line) => line.includes('PgUp history')));
  assert.ok(lines.some((line) => line.includes('Ctrl+R sessions')));
  assert.ok(lines.some((line) => line.includes('Enter send')));
  assert.ok(lines.some((line) => line.includes('Ctrl+J newline')));
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

test('welcome keeps an unsafe actor label on one terminal row', () => {
  const lines = buildWelcomeLines({
    session: {
      ...SESSION,
      actor: {
        label: ' 豆包\n助手\x1B ',
        summary: 'Local helper',
      },
    },
    width: 80,
    connection: 'connected',
  });
  const title = lines.find((line) => line.includes('PinPawo TUI v2 ·'));
  assert.match(title ?? '', /PinPawo TUI v2 · 豆包 ↵ 助手�/);
  assert.doesNotMatch(title ?? '', /[\r\n\x1B]/);
});

test('displayed TUI version matches the workspace package', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  assert.equal(TUI_VERSION, packageJson.version);
});
