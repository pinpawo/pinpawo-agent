# Channel Router

> 状态：设计草案，未实现
> 更新：2026-10-22

## 问题

Channel 里没有 @ 的消息只写入时间线，不会派发给任何 Pet（[Channel 模型](channel-model.md) §交接）。
这符合"自然对话"：人和人之间说话不该唤醒 Pet。但用户常常只是没指定对象，并不是不需要回应。
例如在有 Executor、Reviewer、Wiki 的 Channel 里问"#1003 是谁在处理？"，现在没有任何人接。

缺的是**分诊**：判断这条消息要不要交给 Pet、交给谁。Channel 不加兜底 Pet，也不加特殊成员。
分诊由一个独立的可选 Plugin 完成，它用轻量决策模型，与 Pet 的 Agent runtime 无关。

## 边界

- `channel-router` 是独立的 Studio Plugin，可选安装。没装它时，行为保持不变：无 @ 消息只存不派发。
- 它**不发言**。它只决定交给谁，被选中的 Pet 按普通交接收到消息，由它自己回答。所以 Channel 的作者仍然只有 `human | pet`，
  4 张表不变。
- 它**不看过程**。它的输入只有 Channel 成员和公开消息，不读 Pet session、operation 或运行状态。
  "#1003 谁在处理"这类问题，它只需要从公开消息里认出是 Executor 提过 #1003，然后交给 Executor；
  Executor 的 session 里有这件事的上下文，由它回答。
- 它**与 Agent runtime 无关**。不经过 pet-agent、Supervisor、Toolkit 或 LangChain 模型配置，
  只做一次决策模型调用。

## 触发条件

只处理同时满足以下条件的消息：

1. `channel.message.created` 事件里的消息作者是 `human`。Pet 的消息从不触发，避免 Pet 之间无 @ 的循环。
2. 消息的 `mentions` 为空。有 @ 的消息已经由 Channel 交付，router 不参与。
3. 所在 Channel 至少有一个 Pet 成员。

`replyTo` 不特殊处理：回复 Pet 的消息同样交给 router 判断，原作者只作为输入的一部分。

## 决策

Router 向决策模型提出两个问题，在一次请求里完成：

| 问题 | 类型 | 选项 |
|------|------|------|
| `needsPet`：这条消息需要 Pet 处理吗？ | 是/否概率（Jev `Noul`） | — |
| `target`：交给谁？ | 多选一（Jev `Choice`） | 当前 Channel 的 Pet 成员（`participantId`）+ `none` |

输入（program state）：

- 当前消息：作者 label、正文、`replyTo` 的作者和正文。
- Channel 标题和说明。
- Pet 成员：`participantId`、名称，以及 router 配置里该 Pet 的一句话说明（见下文“配置”）。
- 最近 N 条公开消息（默认 20）：作者、正文截断到固定长度。

决策规则：

- `needsPet < needsPetThreshold`（默认 0.5），或 `target = none`，或 `target` 的置信度 `< targetThreshold`（默认 0.6）：不派发。
- 否则只选概率最高的一个 Pet 派发。本阶段不做多选：多个 Pet 都合适时，由被选中的 Pet 在回复里 @ 其他人。

选错了不需要专门的纠正机制：用户 @ 正确的 Pet 即可，下一条有 @ 的消息走普通路径。

## 派发

Channel 新增一个 hook `route`，由 router 调用：

```ts
type ChannelRouteHook = {
  route: (input: {
    channelId: string;
    messageId: string;
    participantId: string;            // 必须是当前 Pet 成员
    reason: { confidence: number; needsPet: number };
  }) => Promise<ChannelDelivery>;
};
```

- Channel 校验消息存在、消息作者是 human、没有 mentions、`participantId` 是当前 Pet 成员。
- 复用 `deliver()` 里的单个 Pet 派发（`dispatchPet`），session 和 `scope:{namespace:'channel'}` 与 @ 相同。
  idempotencyKey 是 `channel:<channelId>:<messageId>:route`，所以每条消息最多被路由一次。
- 派发输入仍是 `channel_message` 封装，额外带 `addressedBy: 'router'`，让 Pet 知道这条消息没有点名找它：
  不确定是不是自己的事时，可以简短说明并 @ 更合适的成员。
- 消息本身不改写：不补 mentions，正文原样保存。
- 投递结果照常发布 `channel.delivery` 事件，多带 `via: 'router'` 和 `confidence`。

Router 决定不派发时，发布 `channel.route.skipped` 事件（含 channelId、messageId、原因和分数），不写 Channel。

## 配置

```json
{
  "id": "@pinpawo-plugin/channel-router",
  "options": {
    "model": { "kind": "jev", "baseUrl": "https://…", "apiKeyEnv": "PINPAWO_ROUTER_API_KEY", "model": "typesafe/jev-1.13" },
    "pets": {
      "executor": "执行代码、命令和交付类请求；也负责回答它做过的工作的进度。",
      "reviewer": "审查代码、PR 和交付结果。",
      "wiki": "维护项目 Wiki 和文档。"
    },
    "historyLimit": 20,
    "needsPetThreshold": 0.5,
    "targetThreshold": 0.6
  }
}
```

- `pets` 里的说明只供 router 使用，不改 Pet 的定义。没写说明的 Pet 只用名称参与选择。
- `model.kind` 决定决策客户端。Router 内部只依赖一个接口：

  ```ts
  type RouteDecider = (input: RouteInput) => Promise<{ needsPet: number; target: string; confidence: number }>;
  ```

  首个实现是 Jev（TypeSafe 原生 API 或 ZenMux 转发，请求格式在实现时按其文档确定）。
  之后可以换成 Kev 本地服务，或普通小 LLM 加结构化输出，只改这一层。
- 决策调用失败或超时（默认 3s）：视为不派发，发布 `channel.route.skipped`（原因 `error`）。消息已经保存，不重试。

## Console

- 路由成功：消息下方显示"已转给 Executor"，悬停显示置信度。
- 跳过：显示"未分派"，和现在无 @ 的状态一样，悬停显示原因。
- 输入框下方的提示改为按是否安装 router 显示："没有 @ 时由路由决定交给谁"或现在的"不会唤醒 Pet"。

## 不做的事

- Router 不回答问题、不写 Channel 消息、不读 Pet session 或运行状态。
- 不给 Channel 加默认 Pet 字段或成员角色。
- 不处理 Pet 发的消息。
- 不做多目标派发和重试。

## 待定

- Jev 的接入方式：直连 TypeSafe API 还是经 ZenMux；国内网络能否访问。实现前用真实调用确认格式和延迟。
- 是否需要 eval：用一组带标注的 Channel 片段（含"谁在处理 X"、闲聊、明确请求）比较 Jev 与小 LLM 的准确率和成本。

## 涉及的改动

| 位置 | 改动 |
|------|------|
| `plugins/channel` | 暴露 `route` hook；`channel_message` 封装加可选 `addressedBy`；`channel.delivery` 事件加 `via`/`confidence` |
| `plugins/channel-router`（新） | 订阅 `channel.message.created`，读成员和最近消息，调用 `RouteDecider`，调用 `route` |
| `apps/studio-console` | 显示路由结果和跳过原因；提示文案 |
| 默认 Pet 模板 | PET.md 说明 `addressedBy: 'router'` 的含义 |
| 文档 | `channel-model.md` §交接 指向本文；`docs/studio/configuration.md` 加插件配置 |
