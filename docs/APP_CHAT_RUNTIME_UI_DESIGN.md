# App Chat Runtime UI Design

## Context

当前 app 侧主聊天入口是 `src/features/onboarding/MyPetScreen.tsx`。旧的 `app/chat.tsx` 已移除，避免继续存在第二套聊天实现。

这轮优化的目标不是重做聊天页，而是把 agent run 的显示方式整理清楚：用户消息、pet 回复、工具执行、等待动效、错误、打断和 HITL 不应该混在一条普通消息流里处理。

## Goals

- 让 app 像 TUI 一样清楚展示 agent 当前在做什么。
- 保持手机端交互轻量：不要把每个工具事件都塞进聊天气泡。
- 等待期间继续使用 pet gif，但 gif 状态要来自明确的运行态。
- 为后续 interrupt 和 HITL 留出接口，而不是把它们伪装成普通错误或普通消息。
- 优先优化 `MyPetScreen.tsx`，避免继续在旧 `app/chat.tsx` 上堆逻辑。
- 全局 pet 状态收敛到 Zustand `src/state/petStore.ts`，不再通过 `PetProvider` 提供 Context。
- pet 选择/管理只有一个入口：`/pets`。聊天页顶部 pet chip 直接进入该页面，不再保留抽屉式 pet 选择器。

## Runtime Shape

聊天消息和运行态分开：

- `ChatMessage`: 持久消息，只记录用户、pet、系统提示等需要留在历史里的内容。
- `ChatRunState`: 当前这一轮请求的临时状态，只用于 UI 展示，不进入历史消息。

推荐运行阶段：

- `idle`: 没有请求在进行。
- `thinking`: 请求已发出，还没有 token 或工具事件。
- `using_tool`: agent 正在执行工具。
- `streaming`: pet 回复正在流式输出。
- `interrupting`: 用户请求打断，等待服务端确认。
- `interrupted`: 请求已被打断。
- `waiting_human`: 服务端需要用户确认或补充。
- `error`: 当前请求失败，输入应恢复可用。

## Message Rules

- 用户输入进入历史消息。
- pet 的自然语言回复进入历史消息，并支持 streaming 更新。
- 工具 start/event/end 不默认进入历史消息，只更新当前运行态。
- 工具失败、网络失败、服务端异常可以写入 `system` 消息，但不要伪装成 pet 回复。
- `system` 消息必须在聊天 UI 中可见，使用独立的系统样式，而不是混入工具日志或 debug 面板。
- partial pet 回复如果被打断，需要标记为 interrupted/incomplete，避免看起来像完整回答。

## New Session

新会话是显式用户动作，不等同于“清空消息”。

- 入口放在输入栏一侧的系统操作菜单中，不放在顶部 header；后续系统交互能力继续扩展这个菜单。
- app 调用 `/pet/chat/session`。
- API 验证 pet 归属后，如果 local-agent 在线，向 agent WS 发送 `new_session`。
- local-agent 删除当前 chat thread checkpoint。
- app 清空当前 pet 的本地聊天显示，并写入一条可见的 `system` 消息。
- 如果服务端重置失败，app 不清空当前聊天，只写入系统错误消息。

## Operation Activity UI

工具执行应该显示成当前运行状态，而不是连续刷屏：

- 顶部 pet 展位展示当前 operation 对应的 gif 和短文案。
- 聊天列表 footer 只在没有 token 时显示等待气泡。
- 后续可以增加一个 compact operation activity strip，显示最后一个 operation 和状态。

gif 映射建议：

- thinking: `thinking`，使用 `assets/chat/sheep/thinking.gif`
- streaming: `typing`，使用 `assets/chat/sheep/typing.gif`
- waiting_human: `waiting`，使用 `assets/chat/sheep/waiting.gif`
- `operation.kind` / `title` / `summary` 命中 browser / network / search / fetch / open / click / type：`browser`，使用 `assets/chat/sheep/browser.gif`
- `operation.kind` / `title` / `summary` 命中 shell / command / file / read / write / edit：`file`，使用 `assets/chat/sheep/file.gif`
- interrupting/error: `interrupted`，使用 `assets/chat/sheep/interrupted.gif`
- audio/music/play/video/media: `media`，使用 `assets/chat/sheep/media.gif`
- idle/low priority: `slacking`，使用 `assets/chat/sheep/slacking.gif`
- legacy do-not-disturb: `doNotDisturb` 仍保留，当前指向文件处理动画。
- unknown operation: `typing`

## Interrupt

打断不是普通错误，也不是普通用户消息。

需要的协议能力：

- 发起 chat stream 时拿到或生成 `requestId`。
- app 调用 `POST /pet/chat/interrupt` 或等价接口提交 `requestId`。
- app 本地进入 `interrupting`，释放输入框。
- 服务端确认后进入 `interrupted`。
- 迟到的 token/tool event 必须按 `requestId` 忽略。

UI 上：

- active run 期间展示停止按钮。
- 打断中的 pet 展位显示明确状态。
- 被打断的 partial 回复保留但标记，不追加“回复失败”。

## HITL

HITL 和 interrupt 分开处理。

- interrupt 是用户主动停止当前 run。
- HITL 是 agent 主动请求用户确认、选择或提供信息。

服务端输出 `LocalAgentEvent`：`human_review.requested`。app 进入 `waiting_human`，在输入框上方展示确认面板，支持批准、拒绝和直接输入补充说明。确认后携带 resume 继续同一个任务上下文；补充说明不做前端文本映射，交给 local-agent 侧按当前 pending interrupt 解释。

## Event Evolution

目标事件模型以 `LocalAgentEvent` 为准：

- `message.delta`
- `message.completed`
- `operation`
- `human_review.requested`
- `system.notice`
- `error`

`pinpawo-app` app/API 需要消费 `LocalAgentEvent` envelope；local-agent 不再发送旧运行态消息。

app run state 可以在 API envelope 中补充这些控制字段：

- `run_started`
- `run_interrupted`
- `request_id`

## Implementation Plan

1. 新增 chat run reducer，把运行态从 `MyPetScreen.tsx` 的多个 `useState` 中抽出来。
2. `MyPetScreen.tsx` 使用 reducer 驱动等待 gif、footer typing、工具活动和错误恢复。
3. 工具事件默认不再逐条写入聊天历史，只影响当前运行态。
4. 给 `ChatMessage` 增加 `system` 和状态字段，错误先作为系统提示展示。
5. 在输入栏系统操作菜单中新增新会话入口，调用 API 重置 local-agent chat thread，并写入可见系统消息。
6. 在服务端协议具备 request id 后接入 interrupt UI。
7. 在服务端输出 HITL 事件后接入 `waiting_human` 面板。
8. 后续 interrupt 和 HITL 只接入 `MyPetScreen.tsx` 这一套聊天 runtime。

## Non-goals

- 不在这轮引入复杂任务结构或 app 侧 agent state 镜像。
- 不把工具日志完整复刻成聊天消息。
- 不针对某个具体任务写目标性 prompt 或 app 侧规则。
