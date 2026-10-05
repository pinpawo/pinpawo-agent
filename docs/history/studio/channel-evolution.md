# Channel 演进记录

状态：历史记录，2026-10-05。当前实现只见
[Channel 寻址、执行与状态](../../design/studio/channel-addressing-and-execution.md)。
本记录不代表已部署到用户 workdir，也不定义兼容或自动迁移机制。

## 阶段

- [#897](https://github.com/pinpawo/pinpawo-agent/pull/897)：持久 pair session、可信 scope、
  completed 普通输出、独立 waiting 历史与原 TUI 审批终态。
- [#903](https://github.com/pinpawo/pinpawo-agent/pull/903)：Kanban 专属入口与消费者退役；
  历史数据库及用户文件保留，默认模板启用 Channel。
- [#904](https://github.com/pinpawo/pinpawo-agent/pull/904)：统一参与者寻址、多目标交接、
  全局队列观察、Reply 默认作者与服务端来源封装。已于 2026-10-05 合并为
  `138fd28663b04f2d1ff1ec8ab12193db44ce2977`。

## 已取代的说法

第一片“不因寻址自动执行”“replyTo 只能回原 Pet”，以及后续草案中的本地分支、
待定接口和实施顺序，记录当时的阶段范围。现在统一消息入口处理有效目标，引用与目标
独立；人的 Reply 仅在 UI 预选作者，Pet 仍自主交接。自动排队回执保持暂缓。

曾将最终公开回复协议放入 pet-agent，后移回外部 PET.md / Capability。
原始失败、各次真实模型验收与未覆盖场景保留在 #904，不能跨 head 合并为一次通过。

## 原文

文档整理前的文本保留在合并版本中，无需在当前设计重复全文：

- [基础草案原文](https://github.com/pinpawo/pinpawo-agent/blob/138fd28663b04f2d1ff1ec8ab12193db44ce2977/docs/design/studio/channel-collaboration.md)
- [寻址与实施草案原文](https://github.com/pinpawo/pinpawo-agent/blob/138fd28663b04f2d1ff1ec8ab12193db44ce2977/docs/design/studio/channel-addressing-and-execution.md)
- [Console 阶段记录原文](https://github.com/pinpawo/pinpawo-agent/blob/138fd28663b04f2d1ff1ec8ab12193db44ce2977/docs/design/studio/console.md)
