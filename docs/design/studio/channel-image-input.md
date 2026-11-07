# Channel 图片输入

状态：draft。领域归属：Channel 派发与 Host 输入准入。

## 消息来源

Channel 的 `@Pet` 派发明确携带触发消息的正文、作者、消息 ID 和交付引用。设置 `replyTo` 时，同时携带同一 Channel 中那条被回复消息的正文、作者和引用。

图片来源按触发消息、被回复消息的顺序选取，按 URI 保留首次引用。正文中出现的链接继续作为正文；附件来源是已存消息的结构化 `deliverables`。

## 结构化派发

Channel 将引用放入进程内 `StudioDispatchRequest.attachments`，Studio 快照后传给 `PetDispatchRequest.attachments`。这些引用独立于原有 `request` 文本传递，Host 在执行准备阶段解析。

`attachments` 属于可信的进程内派发字段。Studio wire 请求继续使用既有公开字段，Channel 成员、目标 Pet、指定 session 和 Channel scope 沿既有权限链校验。

触发消息的发言者与目标 Pet 使用当前成员权限；被回复消息属于同一 Channel 历史。artifact 引用沿既有文件显式共享语义读取。

## Host 图片准入

Host 使用当前配置的 artifact store 读取显式的 `artifact://` 引用。local store 提供文件流，COS 提供的临时地址仅供 Host 内部读取字节。

Host 根据存储回执的 MIME 选择图片，校验实际字节的格式签名、大小与完整性，再复用既有图片输入构造，生成 LangChain 标准图片块：

```ts
{ type: 'image', mimeType, data: base64 }
```

准入使用本次实际执行 setup 的模型能力，包括派发到非活跃 session 的场景。沿用现有约束：PNG、JPEG、WebP；最多 4 张，单张 10 MiB，合计 20 MiB。数量和总量覆盖触发消息及被回复消息中的所有图片。

HumanMessage 保留原始派发正文，`pinpawo.artifactReferences` 保存结构化引用。图片内容以字节进入标准图片块；图片展示元数据使用名称、格式、大小和摘要。

## 处理结果

| 输入情况 | 行为 |
|---|---|
| 可读取且受支持的图片 | 正文、结构化引用和图片块共同进入模型输入 |
| 非图片 artifact | 保留引用，明确说明作为引用提供 |
| 普通 URL 等其他引用 | 保留引用，明确说明未作为图片加载 |
| artifact 缺失、读取失败或内容损坏 | 派发执行失败，返回清晰的错误 |
| 图片格式、数量或大小超限 | 按图片准入约束失败 |
| 目标模型不支持图片 | 在模型执行前失败 |

派发接受回执表示输入已进入队列；后续执行结果沿既有 dispatch 生命周期与 Agent Session 事件报告。等待审核和取消仍使用现有输入准入流程。

## 验证

- `@` 当前消息携带结构化附件；`replyTo` 合并被回复消息的附件并去重。
- 普通正文链接与缺省附件保持普通文字输入。
- Studio wire 字段与进程内字段的边界清晰，排队前快照引用。
- Host 构造实际 HumanMessage 图片块并保留结构化引用。
- 合成图片覆盖缺图、读取失败、内容损坏、格式与限额、不支持视觉的模型及非活跃目标 session。
- Host 内部临时下载地址和凭据保持在文件读取边界内。
