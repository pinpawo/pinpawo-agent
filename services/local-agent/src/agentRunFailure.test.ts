import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  classifyAgentRunFailure,
  describeFatalAgentRunFailure,
  isFatalAgentRunError,
} from './agentRunFailure';

// Verbatim shape of the failure that regressed review cancellation: the model
// provider rejected the call after the user had already cancelled the review.
const QUOTA_ERROR_MESSAGE = '429 Your token-plan 1-week quota has been exhausted. '
  + 'The quota will reset at 08-20 23:43:00 UTC.\n\n'
  + 'Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/';

describe('classifyAgentRunFailure', () => {
  it('treats an exhausted model quota as fatal and keeps the reset time', () => {
    const error = new Error(QUOTA_ERROR_MESSAGE);
    error.name = 'InsufficientQuotaError';

    const failure = classifyAgentRunFailure(error);

    assert.equal(failure.kind, 'fatal');
    assert.equal(failure.retryAt, '08-20 23:43:00 UTC');
  });

  it('classifies by status code when the error carries provider provenance', () => {
    const failure = classifyAgentRunFailure(
      Object.assign(new Error('request failed'), {
        status: 429,
        llmProvider: 'openai',
      }),
    );

    assert.equal(failure.kind, 'fatal');
  });

  it('treats rejected model credentials as fatal', () => {
    for (const status of [401, 403]) {
      const failure = classifyAgentRunFailure(
        Object.assign(new Error('nope'), { status, llmProvider: 'openai' }),
      );
      assert.equal(failure.kind, 'fatal', `status ${status} should be fatal`);
    }
  });

  it('recognizes a model failure from an SDK stack even without provider fields', () => {
    const error = new Error('429 rate limited');
    error.stack = 'Error: 429 rate limited\n'
      + '    at APIError.generate (/repo/node_modules/@langchain/openai/src/core/error.ts:97:14)';

    assert.equal(classifyAgentRunFailure(error).kind, 'fatal');
  });

  // A tool that speaks HTTP can hit the same status codes as the model. Those
  // must never terminate a pending review: the user's decision is still valid
  // and the agent itself is healthy.
  it('keeps tool-level rate limits and permission errors recoverable', () => {
    const toolFailures: unknown[] = [
      Object.assign(new Error('GitHub API: 429 rate limit exceeded'), { status: 429 }),
      Object.assign(new Error('GitHub API: 403 Forbidden'), { status: 403 }),
      Object.assign(new Error('browser navigation failed'), { statusCode: 429 }),
      new Error('Error: HTTP 429 Too Many Requests'),
      new Error('capability plugin denied: permission_denied'),
      new Error('rate limit exceeded for repository search'),
    ];

    for (const error of toolFailures) {
      assert.equal(
        classifyAgentRunFailure(error).kind,
        'recoverable',
        `${(error as Error).message} must not terminate a pending review`,
      );
    }
  });

  it('keeps ordinary tool and runtime failures recoverable', () => {
    for (const error of [
      new Error('ENOENT: no such file or directory'),
      new Error('apply_patch failed: context did not match'),
      Object.assign(new Error('server error'), { status: 500 }),
      new Error('AbortError'),
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
  });

  it('exposes a fatal predicate', () => {
    assert.equal(isFatalAgentRunError(new Error(QUOTA_ERROR_MESSAGE)), true);
    assert.equal(isFatalAgentRunError(new Error('tool timed out')), false);
  });
});

describe('describeFatalAgentRunFailure', () => {
  it('tells the user when capacity returns and that the run was terminated', () => {
    const text = describeFatalAgentRunFailure(
      classifyAgentRunFailure(new Error(QUOTA_ERROR_MESSAGE)),
    );

    assert.match(text, /08-20 23:43:00 UTC/);
    assert.match(text, /已终止本次运行/);
  });

  it('stays usable when the provider gave no reset time', () => {
    const text = describeFatalAgentRunFailure(
      classifyAgentRunFailure(
        Object.assign(new Error('denied'), { status: 401, llmProvider: 'openai' }),
      ),
    );

    assert.match(text, /模型当前不可用/);
  });
});
