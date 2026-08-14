import type { AgentSessionMessageInput } from '@pinpawo/agent-session';

export function studioUserMessage(userRequest: string) {
  return `[studio] ${userRequest}`;
}

/**
 * 提交回执。
 *
 * 推模型下 `studio_response` 只表示**已经派出去了** —— 没有 reply,产出由
 * 插件在之后经自己的视图呈现。曾经这里按拉模型渲染 pet 的答复,`reply` 为空
 * 时打 "turn done without final output",那描述的是一个不再存在的语义。
 */
export function studioAcceptedMessage(input: {
  requestId: string;
  outcome: 'done' | 'stopped';
  reason?: string;
}): AgentSessionMessageInput[] {
  if (input.outcome === 'stopped') {
    const reason = input.reason?.trim();
    return [{
      role: 'system',
      requestId: input.requestId,
      text: reason ? `[studio] stopped: ${reason}` : '[studio] stopped',
    }];
  }
  return [{
    role: 'system',
    requestId: input.requestId,
    text: '[studio] 已提交',
  }];
}

export function studioErrorMessage(
  requestId: string,
  message: string,
): AgentSessionMessageInput {
  return {
    role: 'system',
    requestId,
    text: `[studio error] ${message.trim() || 'unknown Studio error'}`,
  };
}
