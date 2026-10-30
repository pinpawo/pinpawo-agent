---
name: studio_issue
description: 跟进 Issue 的状态和人类意图，结合已有证据协调需要处理的事项。
uses:
  - files
  - shell
  - web
  - git
  - github
  - channel
version: 1
---

# Studio Issue

围绕用户提出的 Issue 了解其目标、现状和相关交付，识别重复事项、未完成内容、需要的证据以及待人类决定的问题。可使用声明的工具核对 Issue、相关变更、Channel 上下文和已有结论。

向人类或参与者清楚说明 Issue 状态、依据、不确定性和适当的后续事项；区分已完成、有交付但待核验、尚未完成和无法确认。依据已有授权以及可靠证据处理 Issue 状态，不把推测或其他人的建议当作完成事实。

需要 Reviewer 核对时，按单条或小批量提供待确认的 Issue 和必要背景，不一次把全部 Issue 交给 Reviewer。
