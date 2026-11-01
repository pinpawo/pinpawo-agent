# Channel 路由

> 状态：`llm` 决策器已实现（配置读 `studio.json`）；`jev` 决策器和 Console 设置页未实现
> 更新：2026-10-22

## 问题

Channel 里没有 @ 的消息只写入时间线，不会派发给任何 Pet（[Channel 模型](channel-model.md) §交接）。
这符合"自然对话"：人和人之间说话不该唤醒 Pet。但用户常常只是没指定对象，并不是不需要回应。
例如在有 Executor、Reviewer、Wiki 的 Channel 里问"#1003 是谁在处理？"，现在没有任何人接。

缺的是**分诊**：判断这条消息要不要交给 Pet、交给谁。Channel 不加兜底 Pet，也不加特殊成员。
分诊是 Channel 插件内部的一个可开关功能，用一次轻量的模型决策完成，与 Pet 的 Agent runtime 无关。

## 边界

- **在 Channel 内部。** 路由是 `plugins/channel` 的一部分，不是独立 Plugin，也不新增 hook。
  它在消息保存后、`deliver()` 之前运行，选中的 Pet 和 @ 走同一个派发函数。
- **默认关闭。** 关闭时不调用任何模型，无 @ 消息只存不派发，和现在一样。
- **不发言。** 路由只决定交给谁，被选中的 Pet 按普通交接收到消息，由它自己回答。
  Channel 的作者仍然只有 `human | pet`，4 张表不变。
- **不看过程。** 输入包括 Channel 信息、可选协作提示词、成员和公开消息，不读 Pet session、operation 或运行状态。
  "#1003 谁在处理"这类问题，路由只需要从公开消息里认出是 Executor 提过 #1003，然后交给 Executor；
  Executor 的 session 里有这件事的上下文，由它回答。
- **与 Agent runtime 无关。** 不经过 pet-agent、Supervisor 或 Toolkit，只做一次决策调用，没有工具、没有多轮。

## 触发条件

只处理同时满足以下条件的消息：

1. 消息作者是 `human`。Pet 的消息从不触发，避免 Pet 之间无 @ 的循环。
2. 消息的 `mentions` 为空。有 @ 的消息走现有的 mention 交付。
3. 所在 Channel 至少有一个 Pet 成员。
4. 路由设置为开启。

`replyTo` 不特殊处理：服务端不把它当 @。Console 的回复会预填原作者的 @，那时消息已有 mention，不经过路由。

## 决策

### 输入

- 当前消息：作者 label、正文、`replyTo` 的作者和正文。
- Channel 标题、说明和可选协作提示词。该提示词是协作意图，不能授予权限，也不能保证模型按预期路由。
- Pet 成员：`participantId`、名称，以及路由设置里该 Pet 的一句话说明（见“配置”）。
- 最近 N 条公开消息（默认 20）：作者、正文截断到固定长度。

### 输出

两种决策器都返回同一个形状：

```ts
type RouteDecision = {
  target: string | 'none';   // 当前 Pet 成员的 participantId，或 none
  confidence: number;        // 0..1
  reason?: string;           // 只用于展示和事件，不进 Pet 输入
};
type RouteDecider = (input: RouteInput, signal: AbortSignal) => Promise<RouteDecision>;
```

`target = none` 或 `confidence < threshold` 时不派发。只选一个 Pet；多个都合适时，由被选中的 Pet 在回复里 @ 其他人。
选错了不需要专门的纠正机制：用户 @ 正确的 Pet 即可。

### 两种决策器

| | `jev` | `llm` |
|---|---|---|
| 模型 | 决策模型（如 TypeSafe Jev），TypeSafe、ZenMux、国内云厂商都有 | 任何支持结构化输出的聊天模型，建议用便宜快速的（如 deepseek-v4-flash） |
| 调用 | 一次请求两道题：`Noul`（需要 Pet 吗）+ `Choice`（交给谁，选项为 Pet 成员 + `none`） | 一次 chat completion，`response_format` 为 JSON Schema，`target` 是 Pet 成员 + `none` 的 enum |
| confidence | `Choice` 的概率；`Noul` 低于阈值时视为 `none` | 模型自报的 0..1，未经校准；默认阈值更低 |
| 默认超时 | 3s | 10s |
| 优点 | 快、便宜、输出形状由模型保证，概率可用 | 不需要新厂商；复用已有模型配置；能给 `reason` |
| 缺点 | 新接一家 API；只保证形状，不保证决策稳定 | 慢一些、贵一些；confidence 不可靠 |

`llm` 决策器只用 Pet 运行时之外的一次直接调用，不走 LangChain Agent。它的基本路由指令在 Channel 插件里，并接收当前 Channel 的协作提示词作为上下文：
说明任务是"选一个最该回应的 Pet，或 none"，列出 Pet 和说明，要求人和人之间的闲聊、致谢、无需行动的消息选 `none`。

调用失败、超时或返回不合法（`target` 不是当前 Pet 成员）：视为不派发，发布事件，不重试。消息已经保存。

## 派发

- 选中后调用 `deliver()` 里已有的单个 Pet 派发（`dispatchPet`），session 和 `scope:{namespace:'channel'}` 与 @ 相同。
  idempotencyKey 是 `channel:<channelId>:<messageId>:route`，每条消息最多被路由一次。
- 派发输入仍是 `channel_message` 封装，额外带 `addressedBy: 'routing'`，让 Pet 知道这条消息没有点名找它：
  不是自己的事时，可以简短说明并 @ 更合适的成员。
- 消息本身不改写：不补 mentions，正文原样保存。
- 投递结果照常发布 `channel.delivery` 事件，多带 `via: 'routing'`、`confidence`、`reason`。
- 不派发时发布 `channel.routing.skipped`（channelId、messageId、原因 `none | low_confidence | error | invalid`、分数）。

路由是异步的：`POST /channels/messages` 不等模型决策，响应里的 `deliveries` 只含 mention 交付；路由结果通过事件到达 Console。

## 配置

现在设置写在 `studio.json` 里 Channel 插件的 `options.routing`，启动时读取，改了要重启。
路由经 eval 证明有用之后，再按 [Studio Plugin 设置](plugin-settings.md) 改成 Console 可编辑、存数据库、热更新。

```json
{
  "id": "@pinpawo-plugin/channel",
  "options": {
    "routing": {
      "enabled": true,
      "decider": { "kind": "llm", "modelProfileId": "deepseek-v4-flash" },
      "threshold": 0.5,
      "timeoutMs": 10000,
      "historyLimit": 20,
      "pets": {
        "executor": "执行代码、命令和交付类请求；也负责回答它做过的工作的进度。",
        "reviewer": "审查代码、PR 和交付结果。",
        "wiki": "维护项目 Wiki 和文档。"
      }
    }
  }
}
```

`decider` 是按 `kind` 区分的联合：

- `{ "kind": "llm", "modelProfileId": "…" }`：引用 Host 已有的模型配置（与 Pet 的 `modelProfileId` 同一个注册表），
  不另存 baseUrl 和 key；省略 `modelProfileId` 时用 Host 默认配置。Studio 通过 `context.models.resolve(profileId)`
  向 Plugin 提供只读的模型配置（OpenAI 兼容的 baseUrl、model、key 和结构化输出方式）。配置在 Channel 启动时解析，
  不存在的 profile 让启动失败。结构化输出按 profile 的 `structuredOutputMethod`：`jsonSchema` 用 `json_schema`，
  `functionCalling` 用强制的单个函数调用，其余用 `json_object`。
- `{ "kind": "jev", "baseUrl": "…", "apiKeyEnv": "…", "model": "…" }`（未实现）：Jev 不在 Host 的模型配置里，单独配置；
  key 只写环境变量名。各厂商请求格式在实现时按其文档确定。

其他字段：

- `enabled` 默认 `false`。
- `threshold`、`timeoutMs` 没写时按 `kind` 取默认值（`jev`：0.6 / 3000；`llm`：0.5 / 10000）。
- `pets` 里的说明只供路由使用，不改 Pet 的定义。没写说明的 Pet 只用名称参与选择。

本阶段设置是 Studio 全局的，所有 Channel 共用。按 Channel 开关可以以后在 `channels` 表加字段，现在不做。

## Console

- 路由成功：消息头部显示"Executor · routed 86%"，悬停显示原因。
- 跳过：显示"Not routed: …"（无需 Pet / 不确定 / 路由失败），悬停显示细节。
- 输入框下方的提示："Without an @, no Pet is woken unless Channel routing picks one."
- 这些都来自全局事件流，所以只有持本机 token 的 Console 能看到；客户 key 的 Console 不显示路由结果。
- 以后 Plugins 页的 Channel 设置里：开关、决策器类型（`llm` 时下拉选模型配置，`jev` 时填 baseUrl/model/环境变量名）、阈值、Pet 说明。

## 不做的事

- 路由不回答问题、不写 Channel 消息、不读 Pet session 或运行状态。
- 不给 Channel 加默认 Pet 字段或成员角色。
- 不处理 Pet 发的消息。
- 不做多目标派发和重试。

## 待定

- 默认用哪家的 Jev，以及各家请求格式是否一致。实现前用真实调用确认格式和延迟。
- eval：`npm run eval:channel-routing -w @pinpawo-tests/agent-evals`（`ROUTING_EVAL_MODEL_PROFILE_ID=<profile>`）跑 14 个带标注的
  片段（"谁在处理 X"、追问、新请求、回复 Pet、闲聊、致谢、回复人），分别统计误唤醒、漏派、派错和延迟。
  `jev` 实现后用同一组片段比较，决定默认 `kind`。

## 涉及的改动

| 位置 | 改动 |
|------|------|
| `packages/studio` | `context.models.resolve`（已实现）；Plugin 设置机制（以后，见 [plugin-settings.md](plugin-settings.md)） |
| `plugins/channel` | `options.routing`；`llm` 决策器；消息保存后对符合条件的消息异步路由；`channel_message` 加可选 `addressedBy`；事件字段（已实现）；`jev` 决策器（以后） |
| `apps/studio-console` | 显示路由结果和跳过原因、提示文案（已实现）；Plugins 页表单（以后） |
| 默认 Pet 模板 | PET.md 说明 `addressedBy: 'routing'` 的含义 |
| eval | `tests/agent-evals/src/channel-routing.eval.ts` |
| 文档 | `docs/studio/configuration.md` 加设置说明 |
