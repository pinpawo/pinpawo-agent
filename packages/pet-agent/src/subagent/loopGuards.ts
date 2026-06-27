import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { Command, END } from '@langchain/langgraph';
import { estimateMessagesTokens } from '../agent/orchestrator/contextCompaction';

/**
 * Subagent loop guards — the deterministic "should this loop keep calling the
 * model?" predicates. A Guard is a hard pass/block check (no LLM); blocking means
 * "stop the subagent loop now and hand a conclusion back", which the middleware
 * adapter realizes by gracefully ending the agent (`jumpTo: 'end'`) rather than
 * throwing. This mirrors the Decision/Guard split used by the orchestrator: a
 * Guard routes on a hard condition, a Decision chooses among legal next steps.
 *
 * The strategy is an interface on purpose: `RepeatedInputGuard` is the minimal
 * implementation (detect the loop spinning on the same input). Future strategies
 * (conclusion-progress, token-vs-progress ratio, review-for-no-op) plug in as
 * additional `SubagentLoopGuard` implementations without touching callers.
 *
 * See docs/SUBAGENT_LIMIT_FRAMEWORK_DESIGN.md.
 */

export type SubagentLoopGuardInput = {
  /** The system message that will lead the model call (already resolved). */
  systemMessage: BaseMessage;
  /** The conversation messages that will be sent to the model this turn. */
  messages: BaseMessage[];
  /** 1-based count of how many times the model is about to be called. */
  iterationCount: number;
  estimateMessagesTokens: (messages: BaseMessage[]) => number;
};

export type SubagentLoopGuardVerdict =
  | { block: false }
  | { block: true; reason: string; notice: AIMessage };

export type SubagentLoopGuard = {
  readonly name: string;
  evaluate(input: SubagentLoopGuardInput): SubagentLoopGuardVerdict;
};

const LOOP_GUARD_MARKER_KEY = 'subagentLoopGuardStop';

/** Marks an AIMessage as the guard's graceful-stop notice so createSubagent can detect it. */
function buildGuardStopNotice(reason: string, text: string): AIMessage {
  return new AIMessage({
    content: text,
    additional_kwargs: {
      pinpawo: { [LOOP_GUARD_MARKER_KEY]: reason },
    },
  });
}

/** True if the message is a guard graceful-stop notice (set by a blocked guard). */
export function isLoopGuardStopMessage(message: BaseMessage): boolean {
  const pinpawo = (message as { additional_kwargs?: { pinpawo?: unknown } }).additional_kwargs?.pinpawo;
  return Boolean(
    pinpawo
      && typeof pinpawo === 'object'
      && typeof (pinpawo as Record<string, unknown>)[LOOP_GUARD_MARKER_KEY] === 'string',
  );
}

/** True if any message in the list is a guard graceful-stop notice. */
export function messagesHaveLoopGuardStop(messages: BaseMessage[]): boolean {
  return messages.some(isLoopGuardStopMessage);
}

function fingerprintMessages(messages: BaseMessage[]): string {
  // Cheap, allocation-light fingerprint: type + content text per message. Tool
  // call shape is captured indirectly via the AI message content/structure.
  return messages
    .map((message) => {
      const type = message.getType();
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      return `${type}:${content}`;
    })
    .join('');
}

/**
 * Blocks when the exact same model input recurs `threshold` times in a row.
 * This is the minimal "the loop is spinning on the same input" signal — if the
 * messages sent to the model don't change across consecutive turns, the subagent
 * is not making progress and should stop rather than burn tokens.
 */
export function createRepeatedInputGuard(threshold = 3): SubagentLoopGuard {
  let lastFingerprint: string | null = null;
  let repeatCount = 0;
  return {
    name: 'RepeatedInputGuard',
    evaluate({ messages }) {
      const fingerprint = fingerprintMessages(messages);
      if (fingerprint === lastFingerprint) {
        repeatCount += 1;
      } else {
        lastFingerprint = fingerprint;
        repeatCount = 1;
      }
      if (repeatCount >= threshold) {
        return {
          block: true,
          reason: 'repeated_input',
          notice: buildGuardStopNotice(
            'repeated_input',
            [
              '检测到子任务在用相同的输入反复调用模型，已判定为原地打转并停止。',
              '请根据现有进度调整任务、收窄范围或换一种方式继续。',
            ].join('\n'),
          ),
        };
      }
      return { block: false };
    },
  };
}

/**
 * Blocks when the estimated token footprint of the next model call reaches the
 * context-window fuse threshold. Replaces the old throw-based fuse with a
 * graceful stop expressed through the same Guard abstraction.
 */
export function createContextWindowFuseGuard(limitTokens: number): SubagentLoopGuard {
  return {
    name: 'ContextWindowFuseGuard',
    evaluate({ systemMessage, messages, estimateMessagesTokens }) {
      const estimatedTokens = estimateMessagesTokens([systemMessage, ...messages]);
      if (estimatedTokens >= limitTokens) {
        return {
          block: true,
          reason: 'context_window_fuse',
          notice: buildGuardStopNotice(
            'context_window_fuse',
            [
              '当前子任务的上下文已接近模型窗口上限，已暂停继续调用模型。',
              `估算 token：${estimatedTokens}，保险丝阈值：${limitTokens}。`,
              '请根据现有进度决定是否拆分任务、续跑或收窄范围。',
            ].join('\n'),
          ),
        };
      }
      return { block: false };
    },
  };
}

/**
 * Position adapter: runs the given loop guards in the `wrapModelCall` middleware
 * position — i.e. on the exact messages about to be submitted to the model
 * (after contextPolicy compression), which is what "repeated input" means. On the
 * first blocking verdict it gracefully ends the agent by returning a Command that
 * routes to END with the guard's notice appended — no throw, no model call.
 * createSubagent reads the marker to report `completionReason: 'limit_reached'`.
 *
 * This is the `middleware(pos) -> Guard` edge of the framework; a graph node can
 * call the same guards via their `evaluate` contract for the `Node -> Guard` edge.
 */
export function createSubagentLoopGuardMiddleware(
  guards: SubagentLoopGuard[],
  fallbackSystemPrompt: string,
) {
  if (guards.length === 0) return null;
  let iterationCount = 0;
  return createMiddleware({
    name: 'SubagentLoopGuards',
    wrapModelCall: async (request, handler) => {
      iterationCount += 1;
      const systemMessage = request.systemMessage
        ?? new SystemMessage(request.systemPrompt ?? fallbackSystemPrompt);
      const input: SubagentLoopGuardInput = {
        systemMessage,
        messages: request.messages ?? [],
        iterationCount,
        estimateMessagesTokens,
      };
      for (const guard of guards) {
        const verdict = guard.evaluate(input);
        if (verdict.block) {
          return new Command({ goto: END, update: { messages: [verdict.notice] } });
        }
      }
      return handler(request);
    },
  });
}
