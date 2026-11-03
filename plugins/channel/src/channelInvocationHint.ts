import type { AgentInvocationHint } from '@pinpawo/pet-agent';

/** Channel owns the preparation requirement; the router only suggests a focus. */
export function channelInvocationHint(channelId: string, request?: string): AgentInvocationHint {
  const focus = readRoutingFocus(channelId, request);
  return {
    source: 'channel',
    instruction: '开始本轮业务处理或作出收口判断前，先委派已配置的 channel_context Capability，读取并总结最新相关 Channel 消息，确认原始人类要求、已有成果和后续更正；再结合自身职责判断本轮是否仍需行动。已经完成的事项不重复执行。没有该 Capability 时，通过可用的 channel_read_context 工具补齐背景；缺少读取能力或读取失败时说明缺口，不猜测。',
    ...(focus === undefined ? {} : { focus }),
  };
}

function readRoutingFocus(channelId: string, request?: string): string | undefined {
  if (request === undefined) return undefined;
  // Parse only the complete Plugin-owned outer envelope. Quoted body/replyTo
  // text must never become another active hint or supply its instruction.
  const match = /^(`{3,})json\n([\s\S]*)\n\1$/.exec(request);
  if (!match) return undefined;
  let value: unknown;
  try { value = JSON.parse(match[2]!); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.type !== 'channel_message' || input.version !== 1
    || input.channelId !== channelId || input.addressedBy !== 'routing') return undefined;
  const hint = input.contextHint;
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return undefined;
  const fields = hint as Record<string, unknown>;
  if (fields.source !== 'channel-routing' || fields.action !== 'read-latest-channel'
    || typeof fields.focus !== 'string') return undefined;
  const focus = fields.focus.trim();
  return focus.length > 0 && focus.length <= 500 ? focus : undefined;
}
