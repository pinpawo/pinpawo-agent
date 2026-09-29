import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  classifyAgentRunFailure,
  describeFatalAgentRunFailure,
  isFatalAgentRunError,
} from './agentRunFailure';

/**
 * Builds an error shaped the way `@langchain/openai` leaves it after
 * `wrapOpenAIClientError`: the original provider error, plus `lc_error_code`
 * and the troubleshooting URL appended to the message.
 */
function modelError(params: {
  code: string;
  message: string;
  name?: string;
  status?: number;
}) {
  const error = new Error(
    `${params.message}\n\nTroubleshooting URL: `
    + `https://docs.langchain.com/oss/javascript/langchain/errors/${params.code}/\n`,
  ) as Error & { lc_error_code: string; status?: number };
  error.name = params.name ?? 'Error';
  error.lc_error_code = params.code;
  if (params.status !== undefined) error.status = params.status;
  return error;
}

// The exact failure that regressed review cancellation. Verified against the
// real @langchain/openai wrapper: status 429 is stamped MODEL_RATE_LIMIT.
const QUOTA_ERROR = modelError({
  code: 'MODEL_RATE_LIMIT',
  name: 'InsufficientQuotaError',
  status: 429,
  message: 'Your token-plan 1-week quota has been exhausted. '
    + 'The quota will reset at 08-20 23:43:00 UTC.',
});

describe('classifyAgentRunFailure', () => {
  it('treats an exhausted model quota as fatal and keeps the reset time', () => {
    const failure = classifyAgentRunFailure(QUOTA_ERROR);

    assert.equal(failure.kind, 'fatal');
    assert.equal(failure.code, 'MODEL_RATE_LIMIT');
    assert.equal(failure.retryAt, '08-20 23:43:00 UTC');
  });

  it('treats rejected model credentials and a missing model as fatal', () => {
    for (const code of ['MODEL_AUTHENTICATION', 'MODEL_NOT_FOUND']) {
      const failure = classifyAgentRunFailure(
        modelError({ code, message: 'nope' }),
      );
      assert.equal(failure.kind, 'fatal', `${code} should be fatal`);
      assert.equal(failure.code, code);
    }
  });

  it('finds the model error code through a wrapping graph error', () => {
    const wrapped = new Error('Graph node "model_request" failed', {
      cause: QUOTA_ERROR,
    });

    assert.equal(classifyAgentRunFailure(wrapped).kind, 'fatal');
  });

  it('survives a cyclic cause chain', () => {
    const outer = new Error('outer') as Error & { cause?: unknown };
    const inner = new Error('inner') as Error & { cause?: unknown };
    outer.cause = inner;
    inner.cause = outer;

    assert.equal(classifyAgentRunFailure(outer).kind, 'recoverable');
  });

  // A tool that speaks HTTP hits the same status codes as the model, but never
  // carries lc_error_code — only the model integration stamps it. These must
  // never terminate a pending review.
  it('keeps tool-level rate limits and permission errors recoverable', () => {
    const toolFailures: unknown[] = [
      Object.assign(new Error('GitHub API: 429 rate limit exceeded'), { status: 429 }),
      Object.assign(new Error('GitHub API: 403 Forbidden'), { status: 403 }),
      Object.assign(new Error('browser navigation failed'), { statusCode: 429 }),
      new Error('Error: HTTP 429 Too Many Requests'),
      new Error('capability plugin denied: permission_denied'),
      new Error('rate limit exceeded for repository search'),
      // Even an exhausted-quota *message* is recoverable without the code:
      // only the model integration can vouch that the model itself failed.
      new Error('upstream quota has been exhausted'),
    ];

    for (const error of toolFailures) {
      assert.equal(
        classifyAgentRunFailure(error).kind,
        'recoverable',
        `${(error as Error).message} must not terminate a pending review`,
      );
    }
  });

  it('keeps recoverable LangChain codes out of the fatal set', () => {
    // Context overflow is fixable by compaction; invalid tool results have
    // their own session-reset path. Neither may discard a pending review.
    for (const code of ['CONTEXT_OVERFLOW', 'INVALID_TOOL_RESULTS', 'MODEL_ABORTED']) {
      assert.equal(
        classifyAgentRunFailure(modelError({ code, message: 'x' })).kind,
        'recoverable',
        `${code} should stay recoverable`,
      );
    }
  });

  it('keeps ordinary tool and runtime failures recoverable', () => {
    for (const error of [
      new Error('ENOENT: no such file or directory'),
      new Error('apply_patch failed: context did not match'),
      Object.assign(new Error('server error'), { status: 500 }),
    ]) {
      assert.equal(
        classifyAgentRunFailure(error).kind,
        'recoverable',
        `${error.message} should stay recoverable`,
      );
    }
  });

  it('defaults unknown values to recoverable rather than terminating a review', () => {
    assert.equal(classifyAgentRunFailure(undefined).kind, 'recoverable');
    assert.equal(classifyAgentRunFailure('something odd').kind, 'recoverable');
    assert.equal(classifyAgentRunFailure(null).kind, 'recoverable');
  });

  it('exposes a fatal predicate', () => {
    assert.equal(isFatalAgentRunError(QUOTA_ERROR), true);
    assert.equal(isFatalAgentRunError(new Error('tool timed out')), false);
  });
});

describe('describeFatalAgentRunFailure', () => {
  it('tells the user when capacity returns and that the run was terminated', () => {
    const text = describeFatalAgentRunFailure(classifyAgentRunFailure(QUOTA_ERROR));

    assert.match(text, /08-20 23:43:00 UTC/);
    assert.match(text, /已终止本次运行/);
  });

  it('points at the credentials when authentication was rejected', () => {
    const text = describeFatalAgentRunFailure(
      classifyAgentRunFailure(modelError({ code: 'MODEL_AUTHENTICATION', message: 'denied' })),
    );

    assert.match(text, /API key/);
  });

  it('points at the model name when the model does not exist', () => {
    const text = describeFatalAgentRunFailure(
      classifyAgentRunFailure(modelError({ code: 'MODEL_NOT_FOUND', message: 'missing' })),
    );

    assert.match(text, /模型不存在/);
  });
});
