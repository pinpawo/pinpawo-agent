# Daily Post Capability 需求说明

## 目标
`daily_post` 是 `pet-agent` 的一个能力，用来让宠物生成、保存或跳过一条 daily post。

它解决的是：
- 用户明确要求“发一条动态”“写一条今天的内容”
- scheduler 需要驱动宠物按节奏产出 daily post
- 在已经拿到热点或已有上下文时，完成最终成文和落库

它不负责：
- 判断是否要先看热点
- 做通用聊天回复
- 维护长期记忆

## 触发条件
当当前任务已经明确进入“要产出一条动态”的阶段时，agent 可以激活 `daily_post`。

典型触发场景：
- 用户直接说“帮我发一条动态”
- 用户说“根据刚刚那个热点，写一条今天的内容”
- scheduler 触发每日发帖任务

## 输入
`daily_post` 运行时依赖以下输入：
- 当前 actor 信息
- 当前对话消息
- 最近几条 daily post
- 当前可引用的 trend items
- 可选的 dry-run 标记

宿主侧还需要提供副作用接口：
- `savePost`
- `markUsed`
- `markSkipped`
- `requestImageProcessing`

## 对外工具
第一版保留两个工具：

### `finalize_post`
用于确认这条 daily post 的最终内容并执行保存。

支持两种模式：
- `original`
- `repost`

主要字段包括：
- `content`
- `intent`
- `angle`
- `whyToday`
- `mood`
- `topic`
- `tags`
- `citations`
- `repostTrendId`
- `requestImage`

### `skip_post`
用于本轮明确跳过，不发动态。

需要返回跳过原因。

## 结果
`daily_post` 的最终结果写入 `daily_post.result`。

结果结构：
- `status`: `created | skipped | failed`
- `postId`: 创建成功时的 post id，否则为 `null`
- `reason`: 跳过或失败原因
- `payload`: 创建成功时的正文 payload，否则为 `null`
- `imageRequested`: 是否已向系统提交图片处理请求

## 关键约束
- 每次能力执行只产出一个结果
- `repost` 模式必须绑定可用的热点
- 近期重复内容要被拦截
- 如果是 `original` 且请求配图，`daily_post` 只负责提交一个 image request
- 图片生成或图片计划生成属于系统异步模块，不属于 agent 主链
- 正文保存成功后，agent 不再等待图片任务完成

## 与其他能力的关系
- `trend_observe` 负责看热点、挑热点
- `daily_post` 负责把“要不要发、发什么、怎么发”收口成最终动作

常见顺序是：
1. 先由 `trend_observe` 选出一个热点
2. 再由 `daily_post` 决定原创、转发或跳过

但 `daily_post` 也可以在没有热点的情况下，基于当前上下文直接产出原创内容。

## 第一版验收标准
- 能生成原创 daily post
- 能基于选中的 trend item 生成 repost
- 能在不合适时明确跳过
- 能返回稳定的 `daily_post.result`
- 宿主可以基于结果判断：
  - 是否创建成功
  - 是否需要后续图片处理
  - 是否需要记录跳过原因
