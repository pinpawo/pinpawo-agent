import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactAuthorization,
  type ToolAuthorizationRecord,
} from '../review/reviewAuthorizations';
import { createToolAuthorizationRecorder } from './authorization';

function authorization(
  source: ToolAuthorizationRecord['source'],
  createdAt: string,
): ToolAuthorizationRecord {
  return {
    toolName: 'run_process',
    matcher: exactAuthorization({
      argv: ['npm', 'test'],
      cwd: '/repo',
    }),
    source,
    createdAt,
  };
}

test('authorization recorder persists auto-to-human upgrades without length growth', () => {
  const recorder = createToolAuthorizationRecorder([
    authorization('auto_review', '2026-07-29T00:00:00.000Z'),
  ]);

  recorder.recordToolAuthorizations([
    authorization('human', '2026-07-29T00:01:00.000Z'),
  ]);

  assert.equal(recorder.active.length, 1);
  assert.equal(recorder.active[0]?.source, 'human');
  assert.equal(recorder.recorded.length, 1);
  assert.equal(recorder.recorded[0]?.source, 'human');
});

test('authorization recorder applies a batch in one active-state replacement', () => {
  const recorder = createToolAuthorizationRecorder([]);
  const first = authorization('auto_review', '2026-07-29T00:00:00.000Z');
  const second: ToolAuthorizationRecord = {
    toolName: 'run_process',
    matcher: exactAuthorization({
      argv: ['npm', 'run', 'build'],
      cwd: '/repo',
    }),
    source: 'auto_review',
    createdAt: '2026-07-29T00:00:01.000Z',
  };

  recorder.recordToolAuthorizations([first, second]);

  assert.deepEqual(recorder.active, [first, second]);
  assert.deepEqual(recorder.recorded, [first, second]);
});

test('authorization recorder does not record duplicate grants', () => {
  const first = authorization('human', '2026-07-29T00:00:00.000Z');
  const recorder = createToolAuthorizationRecorder([first]);

  recorder.recordToolAuthorizations([
    authorization('human', '2026-07-29T00:01:00.000Z'),
  ]);

  assert.deepEqual(recorder.active, [first]);
  assert.deepEqual(recorder.recorded, []);
});

test('authorization recorder rejects an invalid batch without partial mutation', () => {
  const first = authorization('human', '2026-07-29T00:00:00.000Z');
  const recorder = createToolAuthorizationRecorder([first]);
  const second: ToolAuthorizationRecord = {
    toolName: 'run_process',
    matcher: exactAuthorization({
      argv: ['npm', 'run', 'build'],
      cwd: '/repo',
    }),
    source: 'human',
    createdAt: '2026-07-29T00:01:00.000Z',
  };

  assert.throws(
    () => recorder.recordToolAuthorizations([
      second,
      { ...second, matcher: { type: 'exact', key: 'invalid' } } as never,
    ]),
    /only valid records/,
  );
  assert.deepEqual(recorder.active, [first]);
  assert.deepEqual(recorder.recorded, []);
});
