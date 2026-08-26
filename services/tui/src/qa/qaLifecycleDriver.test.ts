import assert from 'node:assert/strict';
import test from 'node:test';
import type { TuiLaunchOptions } from '../cli/launchOptions';
import type { TuiSessionState } from '../session/sessionController';
import {
  QaLifecycleDriver,
  type QaLifecycleActions,
} from './qaLifecycleDriver';

test('QA lifecycle drives policy smoke once and exits after acknowledgement', () => {
  const calls: string[] = [];
  const driver = new QaLifecycleDriver(
    launch({ policy: true }),
    actions(calls),
    { enqueue: (callback) => callback() },
  );

  driver.handleState(state('ready'));
  driver.handleState(state('ready'));
  assert.deepEqual(calls, [
    'submit:/policy',
    'policy',
  ]);

  driver.handleState(state('ready', {
    globalReviewPolicyMode: 'auto_authorization',
  }));
  assert.deepEqual(calls, [
    'submit:/policy',
    'policy',
    'destroy',
  ]);
});

test('QA lifecycle installs the command smoke frame sequence', () => {
  const calls: string[] = [];
  const frames: Array<() => void> = [];
  const driver = new QaLifecycleDriver(
    launch({ command: true }),
    actions(calls, frames),
  );

  driver.installInitialFrameBehavior();
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(calls, [
    'composer:Smoke footer repaint.',
    'submit-current',
  ]);
  assert.equal(frames.length, 1);
  frames.shift()?.();
  assert.deepEqual(calls, [
    'composer:Smoke footer repaint.',
    'submit-current',
    'destroy',
  ]);
});

function launch(
  smokeOverrides: Partial<TuiLaunchOptions['smoke']>,
): TuiLaunchOptions {
  const smoke = {
    base: false,
    command: false,
    edit: false,
    hostChat: false,
    hostReady: false,
    policy: false,
    review: false,
    transcript: false,
    ...smokeOverrides,
  };
  return {
  showVersion: false,
  agentSession: null,
    demo: {
      command: false,
      qa: false,
      review: false,
    },
    smoke,
    smokeEnabled: Object.values(smoke).some(Boolean),
    hostSmoke: smoke.hostChat || smoke.hostReady,
    useDemoConnection: true,
  };
}

function actions(
  calls: string[],
  frames: Array<() => void> = [],
): QaLifecycleActions {
  return {
    destroySoon: () => calls.push('destroy'),
    onFrame: (callback) => frames.push(callback),
    runPolicySelection: () => calls.push('policy'),
    setComposerText: (text) => calls.push(`composer:${text}`),
    submitCurrentComposer: () => calls.push('submit-current'),
    submitInput: (input) => calls.push(`submit:${input}`),
  };
}

function state(
  connection: TuiSessionState['connection'],
  runtime: TuiSessionState['session']['runtime'] = {},
): TuiSessionState {
  return {
    connection,
    session: {
      sessionId: 'qa',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      pendingInterrupt: null,
      runtime,
    },
  };
}
