import type { AgentInvocationHint } from '@pinpawo/pet-agent';

/** Channel owns the preparation requirement for an explicitly admitted run. */
export function channelInvocationHint(): AgentInvocationHint {
  return {
    source: 'channel',
    instruction: '开始本轮业务处理或作出收口判断前，先委派已配置的 channel_context Capability，读取并总结最新相关 Channel 消息，确认原始人类要求、已有成果和后续更正；再结合自身职责判断本轮是否仍需行动。已经完成的事项不重复执行。没有该 Capability 时，通过可用的 channel_read_context 工具补齐背景；缺少读取能力或读取失败时说明缺口，不猜测。',
  };
}
