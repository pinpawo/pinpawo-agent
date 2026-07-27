import { createAgentSessionSnapshot } from '@pinpawo/agent-session';
import type { AgentHostConnectionFactory } from '../client/localHostConnection';

const DEMO_RUNTIME = {
  model: 'gpt-demo',
  cwd: '/Users/pinpawo/demo',
  contextWindow: 128_000,
} as const;

export function createDemoConnectionFactory(
  options: { review?: boolean } = {},
): AgentHostConnectionFactory {
  return (handlers) => {
    let connected = false;
    let reviewResolved = false;
    let newSessionIndex = 0;
    return {
      connect: () => {
        connected = true;
        handlers.onOpen();
      },
      disconnect: () => {
        connected = false;
      },
      isConnected: () => connected,
      send: (message) => {
        if (!connected) return false;
        if (message.type === 'session.snapshot.get') {
          handlers.onMessage({
            type: 'session.snapshot.result',
            requestId: message.requestId,
            snapshot: createAgentSessionSnapshot({
              sessionId: 'smoke',
              kind: 'chat',
              timeline: [{
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
              }, ...(reviewResolved
                ? [{
                    id: 'smoke-review-result',
                    type: 'message' as const,
                    role: 'assistant' as const,
                    requestId: 'smoke-run',
                    text: 'The review demo completed.',
                    status: 'completed' as const,
                  }]
                : [])],
              activeRun: options.review && !reviewResolved
                ? {
                    requestId: 'smoke-run',
                    state: 'waiting_review',
                    reviewAction: {
                      actionId: 'smoke-review-action',
                      petId: 'paws',
                      reviews: [{
                        id: 'smoke-review',
                        schemaVersion: 1,
                        view: {
                          kind: 'plain',
                          title: 'Allow local operation?',
                          body: 'Review details remain pageable inside the fixed footer.',
                        },
                        options: [{
                          id: 'approve',
                          label: 'Approve',
                          variant: 'primary',
                          decision: { type: 'approve' },
                        }, {
                          id: 'respond',
                          label: 'Respond',
                          input: {
                            kind: 'text',
                            key: 'message',
                            multiline: true,
                          },
                          decision: {
                            type: 'respond',
                            messageInputKey: 'message',
                          },
                        }, {
                          id: 'reject',
                          label: 'Reject',
                          variant: 'danger',
                          decision: { type: 'reject' },
                        }],
                      }],
                    },
                  }
                : null,
              runtime: DEMO_RUNTIME,
            }),
          });
        }
        if (message.type === 'session.list') {
          handlers.onMessage({
            type: 'session.list.result',
            requestId: message.requestId,
            sessions: [{
              id: 'smoke',
              kind: 'chat',
              title: 'Current smoke session',
              messageCount: 3,
              createdAt: '2026-07-27T01:00:00.000Z',
              updatedAt: '2026-07-27T02:00:00.000Z',
              active: true,
            }, {
              id: 'smoke:previous',
              kind: 'chat',
              title: 'Previous command demo',
              messageCount: 2,
              createdAt: '2026-07-26T01:00:00.000Z',
              updatedAt: '2026-07-26T02:00:00.000Z',
              active: false,
            }],
          });
        }
        if (message.type === 'session.new') {
          newSessionIndex += 1;
          const sessionId = `smoke:new-${newSessionIndex}`;
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
            snapshot: createAgentSessionSnapshot({
              sessionId,
              kind: 'chat',
              timeline: [],
              activeRun: null,
              runtime: DEMO_RUNTIME,
            }),
          });
        }
        if (message.type === 'session.resume') {
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
            snapshot: createAgentSessionSnapshot({
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
              runtime: DEMO_RUNTIME,
            }),
          });
        }
        if (
          options.review
          && (
            message.type === 'human_review_response'
            || message.type === 'review.cancel'
          )
        ) {
          reviewResolved = true;
          if (message.type === 'review.cancel') {
            handlers.onMessage({
              type: 'interrupted',
              requestId: 'smoke-run',
              message: 'Review demo cancelled.',
            });
          } else {
            handlers.onMessage({
              type: 'event',
              requestId: 'smoke-run',
              event: {
                type: 'message.completed',
                requestId: 'smoke-run',
                role: 'assistant',
                text: 'The review demo completed.',
              },
            });
          }
        }
        return true;
      },
    };
  };
}
