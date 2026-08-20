import {
  createAgentSessionSnapshot,
  formatChatRequestDisplayText,
  reduceSession,
  type AgentRuntimeEvent,
  type AgentSession,
  type BuiltinGlobalReviewPolicyMode,
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-session';
import type { AgentHostConnectionFactory } from '../client/localHostConnection';
import {
  buildDemoQaEventSequence,
  createDemoQaHistory,
} from './demoQaScenario';

const DEMO_RUNTIME = {
  model: 'gpt-demo',
  cwd: '/Users/pinpawo/demo',
  contextWindow: 128_000,
} as const;
type DemoTimerHandle = unknown;

export type DemoConnectionOptions = {
  review?: boolean;
  qa?: boolean;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => DemoTimerHandle;
  clearScheduled?: (handle: DemoTimerHandle) => void;
};

export function createDemoConnectionFactory(
  options: DemoConnectionOptions = {},
): AgentHostConnectionFactory {
  return (handlers) => {
    let connected = false;
    let newSessionIndex = 0;
    let observedAt = 1_000;
    let globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode =
      'require_authorization';
    let autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel = 'strict';
    let session = createDemoSession(
      options,
      globalReviewPolicyMode,
      autoAuthorizationSafetyLevel,
    );
    const schedule = options.schedule ?? ((callback, delayMs) => (
      setTimeout(callback, delayMs)
    ));
    const clearScheduled = options.clearScheduled ?? ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    const qaRunTimers = new Map<string, Set<DemoTimerHandle>>();

    const project = (
      input: Parameters<typeof reduceSession>[1],
    ) => {
      observedAt += 1;
      session = reduceSession(
        session,
        input,
        { observedAt },
      );
    };
    const clearQaRun = (requestId: string) => {
      const timers = qaRunTimers.get(requestId);
      if (!timers) return;
      for (const timer of timers) clearScheduled(timer);
      qaRunTimers.delete(requestId);
    };
    const clearAllQaRuns = () => {
      for (const requestId of [...qaRunTimers.keys()]) {
        clearQaRun(requestId);
      }
    };
    const scheduleQa = (
      requestId: string,
      delayMs: number,
      callback: () => void,
    ) => {
      const timers = qaRunTimers.get(requestId) ?? new Set();
      qaRunTimers.set(requestId, timers);
      let handle: DemoTimerHandle;
      handle = schedule(() => {
        timers.delete(handle);
        if (timers.size === 0) qaRunTimers.delete(requestId);
        if (connected) callback();
      }, delayMs);
      timers.add(handle);
    };
    const dispatchRuntimeEvent = (event: AgentRuntimeEvent) => {
      project({ type: 'runtime.event', event });
      handlers.onMessage({
        type: 'event',
        requestId: event.requestId,
        event,
      });
    };

    return {
      connect: () => {
        connected = true;
        handlers.onOpen();
      },
      disconnect: () => {
        connected = false;
        const activeQaRequestId = options.qa
          ? session.activeRun?.requestId
          : undefined;
        clearAllQaRuns();
        if (activeQaRequestId) {
          project({
            type: 'run.finished',
            requestId: activeQaRequestId,
            messages: [{
              role: 'system',
              requestId: activeQaRequestId,
              text: 'QA response stopped after the demo transport disconnected.',
            }],
          });
        }
      },
      isConnected: () => connected,
      send: (message) => {
        if (!connected) return false;
        if (message.type === 'session.snapshot.get') {
          handlers.onMessage({
            type: 'session.snapshot.result',
            requestId: message.requestId,
            snapshot: createAgentSessionSnapshot(session),
          });
        }
        if (message.type === 'session.list') {
          handlers.onMessage({
            type: 'session.list.result',
            requestId: message.requestId,
            sessions: [{
              id: session.sessionId,
              kind: session.kind,
              title: 'Current smoke session',
              messageCount: session.timeline.length,
              createdAt: '2026-07-27T01:00:00.000Z',
              updatedAt: '2026-07-27T02:00:00.000Z',
              active: true,
            }, ...(session.sessionId === 'smoke:previous' ? [] : [{
              id: 'smoke:previous',
              kind: 'chat' as const,
              title: 'Previous command demo',
              messageCount: 2,
              createdAt: '2026-07-26T01:00:00.000Z',
              updatedAt: '2026-07-26T02:00:00.000Z',
              active: false,
            }])],
          });
        }
        if (message.type === 'session.new') {
          clearAllQaRuns();
          newSessionIndex += 1;
          const sessionId = `smoke:new-${newSessionIndex}`;
          session = {
            sessionId,
            kind: 'chat',
            timeline: [],
            activeRun: null,
            runtime: {
              ...DEMO_RUNTIME,
              globalReviewPolicyMode,
              autoAuthorizationSafetyLevel,
            },
          };
          handlers.onMessage({
            type: 'session.new.result',
            requestId: message.requestId,
            session: {
              id: sessionId,
              kind: 'chat',
              title: 'New chat session',
              messageCount: 0,
              createdAt: '2026-07-27T03:00:00.000Z',
              updatedAt: '2026-07-27T03:00:00.000Z',
              active: true,
            },
            snapshot: createAgentSessionSnapshot(session),
          });
        }
        if (message.type === 'session.resume') {
          clearAllQaRuns();
          session = {
            sessionId: message.sessionId,
            kind: 'chat',
            timeline: [{
              id: 'smoke-resumed',
              type: 'message',
              role: 'assistant',
              text: `Resumed ${message.sessionId}.`,
              status: 'completed',
            }],
            activeRun: null,
            runtime: {
              ...DEMO_RUNTIME,
              globalReviewPolicyMode,
              autoAuthorizationSafetyLevel,
            },
          };
          handlers.onMessage({
            type: 'session.resume.result',
            requestId: message.requestId,
            session: {
              id: message.sessionId,
              kind: 'chat',
              title: message.sessionId === 'smoke:previous'
                ? 'Previous command demo'
                : 'Current smoke session',
              messageCount: 1,
              createdAt: '2026-07-26T01:00:00.000Z',
              updatedAt: '2026-07-27T02:00:00.000Z',
              active: true,
            },
            snapshot: createAgentSessionSnapshot(session),
          });
        }
        if (message.type === 'session.compact') {
          handlers.onMessage({
            type: 'session.compact.result',
            requestId: message.requestId,
            compacted: false,
            snapshot: createAgentSessionSnapshot(session),
          });
        }
        if (
          options.review
          && (
            message.type === 'human_review_response'
            || message.type === 'review.cancel'
          )
        ) {
          if (message.type === 'review.cancel') {
            project({
              type: 'run.finished',
              requestId: 'smoke-run',
              messages: [{
                role: 'system',
                requestId: 'smoke-run',
                text: 'Review demo cancelled.',
              }],
            });
            handlers.onMessage({
              type: 'interrupted',
              requestId: 'smoke-run',
              message: 'Review demo cancelled.',
            });
          } else {
            dispatchRuntimeEvent({
              type: 'message.completed',
              requestId: 'smoke-run',
              messageId: 'smoke-run:review-demo',
              role: 'assistant',
              text: 'The review demo completed.',
            });
          }
        }
        if (options.qa && message.type === 'chat_request') {
          project({
            type: 'user.accepted',
            requestId: message.requestId,
            kind: 'chat',
            text: formatChatRequestDisplayText(
              message.message,
              message.attachments ?? [],
            ),
          });
          for (const step of buildDemoQaEventSequence(message.requestId)) {
            scheduleQa(
              message.requestId,
              step.delayMs,
              () => dispatchRuntimeEvent(step.event),
            );
          }
        }
        if (options.qa && message.type === 'run.interrupt') {
          clearQaRun(message.requestId);
          project({
            type: 'run.interrupting',
            requestId: message.requestId,
          });
          handlers.onMessage({
            type: 'interrupting',
            requestId: message.requestId,
            message: 'QA response is stopping.',
          });
          scheduleQa(message.requestId, 100, () => {
            project({
              type: 'run.finished',
              requestId: message.requestId,
              messages: [{
                role: 'system',
                requestId: message.requestId,
                text: 'QA response interrupted.',
              }],
            });
            handlers.onMessage({
              type: 'interrupted',
              requestId: message.requestId,
              message: 'QA response interrupted.',
            });
          });
        }
        if (message.type === 'studio_request') {
          queueMicrotask(() => {
            if (!connected) return;
            handlers.onMessage({
              type: 'event',
              requestId: message.requestId,
              event: {
                type: 'studio.progress',
                requestId: message.requestId,
                event: {
                  type: 'tasks_queued',
                  taskCount: 2,
                },
              },
            });
            handlers.onMessage({
              type: 'studio_response',
              requestId: message.requestId,
              outcome: 'done',
              reply: 'Studio demo completed.',
              conversationId: message.conversationId,
              runId: message.requestId,
            });
          });
        }
        if (message.type === 'runtime_config.update' && message.requestId) {
          globalReviewPolicyMode = message.globalReviewPolicyMode;
          autoAuthorizationSafetyLevel = message.autoAuthorizationSafetyLevel
            ?? autoAuthorizationSafetyLevel;
          session = {
            ...session,
            runtime: {
              ...(session.runtime ?? {}),
              globalReviewPolicyMode,
              autoAuthorizationSafetyLevel,
            },
          };
          queueMicrotask(() => {
            if (!connected) return;
            handlers.onMessage({
              type: 'runtime_config.result',
              requestId: message.requestId!,
              globalReviewPolicyMode,
              autoAuthorizationSafetyLevel,
            });
          });
        }
        return true;
      },
    };
  };
}

function createDemoSession(
  options: DemoConnectionOptions,
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode,
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel,
): AgentSession {
  return {
    sessionId: 'smoke',
    kind: 'chat',
    actor: {
      label: 'PinPawo QA',
      summary: 'Deterministic cross-terminal interaction probe',
    },
    timeline: createDemoTimeline(Boolean(options.qa)),
    activeRun: options.review
      ? {
          requestId: 'smoke-run',
          state: 'waiting_review',
          reviewAction: {
            actionId: 'smoke-review-action',
            petId: 'paws',
            reviews: [{
              interactionId: 'smoke-review',
              schemaVersion: 2,
              // A realistic multi-line command: the reviewed content must stay
              // readable even while the response input is focused.
              view: {
                kind: 'plain',
                title: '执行命令',
                body: [
                  'Summary: deploy the release bundle',
                  '',
                  '$ npm run build -- --target production \\',
                  '    --sourcemap false \\',
                  '    --out-dir ./dist/release \\',
                  '    --manifest ./dist/release/manifest.json',
                  '',
                  'Target: /srv/pinpawo/app',
                  '',
                  'Review details remain pageable inside the fixed footer.',
                ].join('\n'),
              },
              options: [{
                id: 'approve',
                label: 'Approve',
                variant: 'primary',
                batchSubmission: 'immediate',
              }, {
                id: 'respond',
                label: 'Respond',
                input: {
                  kind: 'text',
                  key: 'message',
                  multiline: true,
                },
                batchSubmission: 'immediate',
              }, {
                id: 'reject',
                label: 'Reject',
                variant: 'danger',
                batchSubmission: 'immediate',
              }],
            }],
          },
        }
      : null,
    runtime: {
      ...DEMO_RUNTIME,
      globalReviewPolicyMode,
      autoAuthorizationSafetyLevel,
    },
  };
}

function createDemoTimeline(qa: boolean): AgentSession['timeline'] {
  const timeline: AgentSession['timeline'] = qa
    ? createDemoQaHistory()
    : [];
  timeline.push({
    id: 'smoke-user',
    type: 'message',
    role: 'user',
    text: 'Smoke test the Phase 4 vertical slice.',
    status: 'completed',
  }, {
    id: 'smoke-operation',
    type: 'operation',
    requestId: 'smoke-run',
    operationKey: 'smoke-operation',
    kind: 'smoke',
    title: 'Render timeline surface',
    phase: 'completed',
    summary: 'ok',
  }, {
    id: 'smoke-assistant',
    type: 'message',
    role: 'assistant',
    text: 'Connection, projection, and timeline are aligned.',
    status: 'completed',
  });
  return timeline;
}
