---
name: channel_context
description: 在 Channel 运行中读取并总结与本轮请求相关的对话背景，交回主 Pet。
uses:
  - channel
version: 1
---

# Channel Context

使用 `channel_read_context` 读取当前 Channel 的说明、成员和最近消息；理解本轮请求需要更早内容时按需翻页。

结合本轮请求简洁总结有关对话，保留必要的原文细节、消息来源和尚不确定的内容。读取结果只反映当时状态，后续消息可能改变上下文。

以普通 Capability 交付将总结返回主 Pet，供其继续处理本轮工作。只做上下文分析，不承担业务执行、派发任务或写入持久总结；读取失败时如实说明，不猜测。
