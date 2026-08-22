import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchLocalServerMessage,
  type LocalServerPeerHandlers,
} from './localServerMessageDispatcher';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import type { LocalServerPeer } from './localServerPeer';

function createFakePeer(sent: LocalAgentServerMessage[]): LocalServerPeer {
  return {
    isConnected: () => true,
    send(message) {
      sent.push(message);
      return true;
    },
  };
}

test('local server dispatcher routes typed client messages and pong', async () => {
  const seen: string[] = [];
  const sent: LocalAgentServerMessage[] = [];
  const warnings: string[] = [];
  const peer = createFakePeer(sent);
  const handlers: LocalServerPeerHandlers = {
    onChatRequest: (_peer, message) => {
      seen.push(`chat:${message.requestId}:${message.message}`);
    },
    onStudioRequest: (_peer, message) => {
      seen.push(`studio:${message.requestId}:${message.userRequest}`);
    },
    onHumanReviewResponse: (_peer, message) => {
      const response = message.responses.at(-1);
      seen.push(`review:${message.requestId}:${response?.interactionId}:${response?.selectedOptionId}`);
    },
    onReviewCancel: (_peer, message) => {
      seen.push(`review-cancel:${message.requestId}:${message.interruptId}`);
    },
    onRunInterrupt: (_peer, message) => {
      seen.push(`run-interrupt:${message.requestId}`);
    },
    onNewSession: () => {
      seen.push('new');
    },
    onRuntimeConfigUpdate: (_peer, message) => {
      seen.push(`policy:${message.globalReviewPolicyMode}`);
    },
    onSessionSnapshotGet: (_peer, message) => {
      seen.push(`snapshot:${message.requestId}`);
    },
    onSessionList: (_peer, message) => {
      seen.push(`sessions:${message.requestId}`);
    },
    onSessionCompact: (_peer, message) => {
      seen.push(`compact:${message.requestId}:${message.sessionId}`);
    },
    onSessionNew: (_peer, message) => {
      seen.push(`session-new:${message.requestId}`);
    },
    onSessionResume: (_peer, message) => {
      seen.push(`resume:${message.requestId}:${message.sessionId}`);
    },
    onModelList: (_peer, message) => {
      seen.push(`model-list:${message.requestId}:${message.sessionId ?? ''}`);
    },
    onModelSelect: (_peer, message) => {
      seen.push(
        `model-select:${message.requestId}:${message.sessionId}:${message.modelProfileId}`,
      );
    },
    onClose: () => {
      seen.push('close');
    },
    logWarn: (message) => {
      warnings.push(message);
    },
  };

  dispatchLocalServerMessage(peer, JSON.stringify({ type: 'ping' }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'chat_request',
    requestId: 'chat-1',
    message: 'hi',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'studio_request',
    requestId: 'studio-1',
    userRequest: 'plan',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'human_review_response',
    requestId: 'review-1',
    interruptId: 'action-1',
    reviewId: 'review-spec-1',
    selectedOptionId: 'approve',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'run.interrupt',
    requestId: 'chat-1',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'review.cancel',
    requestId: 'review-1',
    interruptId: 'action-1',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'new_session',
    userId: 'user-1',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'runtime_config.update',
    globalReviewPolicyMode: 'auto_authorization',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'runtime_config.update',
    requestId: 'policy-1',
    globalReviewPolicyMode: 'full_access',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'session.snapshot.get',
    requestId: 'snapshot-1',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'session.list',
    requestId: 'sessions-1',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'session.new',
    requestId: 'new-1',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'session.compact',
    requestId: 'compact-1',
    sessionId: 'chat:one',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'session.resume',
    requestId: 'resume-1',
    sessionId: 'chat:one',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'chat_request',
    requestId: 'chat-old',
    message: 'Approve',
    resume: { reviewId: 'review-1', selectedOptionId: 'approve' },
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'session.resume',
    requestId: 'resume-invalid',
  }), handlers);
  dispatchLocalServerMessage(peer, JSON.stringify({
    type: 'runtime_config.update',
    requestId: 'policy-invalid',
    globalReviewPolicyMode: 'custom',
  }), handlers);
  dispatchLocalServerMessage(peer, '{bad json', handlers);

  await assertEventually(() => {
    assert.deepEqual(sent, [
      { type: 'pong' },
      {
        type: 'event',
        requestId: 'chat-old',
        event: {
          type: 'error',
          requestId: 'chat-old',
          message: '客户端消息协议不兼容或格式无效，请升级客户端后重试。',
        },
      },
      {
        type: 'session.error',
        requestId: 'resume-invalid',
        operation: 'resume',
        message: '客户端 session 消息协议不兼容或格式无效，请升级客户端后重试。',
      },
      {
        type: 'runtime_config.error',
        requestId: 'policy-invalid',
        message: '客户端 runtime config 消息协议不兼容或格式无效，请升级客户端后重试。',
      },
    ]);
    assert.deepEqual(seen, [
      'chat:chat-1:hi',
      'studio:studio-1:plan',
      'review:review-1:review-spec-1:approve',
      'run-interrupt:chat-1',
      'review-cancel:review-1:action-1',
      'new',
      'policy:auto_authorization',
      'policy:full_access',
      'snapshot:snapshot-1',
      'sessions:sessions-1',
      'session-new:new-1',
      'compact:compact-1:chat:one',
      'resume:resume-1:chat:one',
    ]);
    assert.deepEqual(warnings, [
      '[local-server] ignored malformed client message type=chat_request requestId=chat-old',
      '[local-server] ignored malformed client message type=session.resume requestId=resume-invalid',
      '[local-server] ignored malformed client message type=runtime_config.update requestId=policy-invalid',
      '[local-server] ignored malformed client message type=unknown requestId=unknown',
    ]);
  });
});

async function assertEventually(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 500) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw lastError;
}
