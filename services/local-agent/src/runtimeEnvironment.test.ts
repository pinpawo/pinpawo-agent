import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeEnvironmentSummary } from './runtimeEnvironment';

test('buildRuntimeEnvironmentSummary includes caller-provided session start time and timezone', () => {
  const summary = buildRuntimeEnvironmentSummary('/tmp/pinpawo-workdir', {
    sessionStartedAt: '2026-06-23T10:30:00+08:00',
    timezone: 'Asia/Shanghai',
  });

  assert.match(summary, /会话开始时间：2026-06-23T10:30:00\+08:00/);
  assert.match(summary, /时区：Asia\/Shanghai/);
  assert.match(summary, /工作目录：\/tmp\/pinpawo-workdir/);
  assert.doesNotMatch(summary, /进程 cwd/);
});

test('buildRuntimeEnvironmentSummary omits session time unless caller provides a stable value', () => {
  const summary = buildRuntimeEnvironmentSummary('/tmp/pinpawo-workdir');

  assert.doesNotMatch(summary, /会话开始时间：/);
  assert.doesNotMatch(summary, /时区：/);
});
