import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserScenarioReporter,
  classifyBrowserScenarioErrorCode,
} from './browser-scenario-report';

test('browser scenario reporter records stable phase, recovery and error summaries', async () => {
  let currentTime = 100;
  const reporter = new BrowserScenarioReporter('extension', 'fixture', () => currentTime);
  currentTime = 120;
  await reporter.run('open', 'first_pass', async () => {
    currentTime = 150;
  });
  reporter.observe('snapshotTextLength', 42);
  reporter.observe('sameOriginFrameVisible', false);
  reporter.observe('openShadowSelectorErrorCode', 'element_not_found');
  currentTime = 160;
  reporter.skip('bridge_restart', 'recovery', 'not supported by this driver');

  assert.deepEqual(reporter.finish(), {
    schemaVersion: 1,
    driver: 'extension',
    scenario: 'fixture',
    durationMs: 60,
    status: 'passed',
    firstPass: 'passed',
    recovery: 'skipped',
    finalErrorCode: null,
    finalErrorCategory: null,
    observations: {
      sameOriginFrameVisible: false,
      openShadowSelectorErrorCode: 'element_not_found',
      snapshotTextLength: 42,
    },
    phases: [
      { name: 'open', kind: 'first_pass', status: 'passed', durationMs: 30 },
      {
        name: 'bridge_restart',
        kind: 'recovery',
        status: 'skipped',
        durationMs: 0,
        reason: 'not supported by this driver',
      },
    ],
  });
});

test('browser scenario reporter preserves driver error codes without error text', async () => {
  const reporter = new BrowserScenarioReporter('playwright', 'fixture', () => 10);
  await assert.rejects(
    reporter.run('snapshot', 'first_pass', async () => {
      throw Object.assign(new Error('sensitive URL should not be reported'), { code: 'origin_changed' });
    }),
  );

  const result = reporter.finish();
  assert.equal(result.status, 'failed');
  assert.equal(result.firstPass, 'failed');
  assert.equal(result.finalErrorCode, 'origin_changed');
  assert.equal(result.finalErrorCategory, 'origin_manual_takeover');
  assert.deepEqual(result.observations, {});
  assert.deepEqual(result.phases[0], {
    name: 'snapshot',
    kind: 'first_pass',
    status: 'failed',
    durationMs: 0,
    errorCode: 'origin_changed',
    errorCategory: 'origin_manual_takeover',
  });
});

test('browser scenario error codes map to durable evaluation categories', () => {
  assert.equal(classifyBrowserScenarioErrorCode('element_not_found'), 'ref_selector');
  assert.equal(classifyBrowserScenarioErrorCode('wait_timeout'), 'stability_wait');
  assert.equal(classifyBrowserScenarioErrorCode('target_closed'), 'target_lifecycle');
  assert.equal(classifyBrowserScenarioErrorCode('origin_changed'), 'origin_manual_takeover');
  assert.equal(classifyBrowserScenarioErrorCode('native_host_disconnected'), 'bridge_lifecycle');
  assert.equal(classifyBrowserScenarioErrorCode('screenshot_unavailable'), 'snapshot_content');
  assert.equal(classifyBrowserScenarioErrorCode('unknown_failure'), 'unexpected');
});
