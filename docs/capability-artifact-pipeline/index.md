# Capability Artifact Pipeline

> 状态：Current
>
> 用途：为 `capability` 能力产物从 `run` 到 `artifact store` 到主流程引用的完整链路提供单独说明。

## 文档结构

1. [架构概览](./architecture.md)
2. [持久化契约](./store-contract.md)
3. [Explore 的压缩与摘要持久化](./explore-ingest.md)
4. [兼容与非持久元数据](./compatibility-notes.md)

## 关注点快速入口

- 我想确认“这次 run 的 artifact 怎么流转？”看：
  - [架构概览](./architecture.md)
- 我想知道每个文件字段和接口是什么：
  - [持久化契约](./store-contract.md)
- 我想核对 explore 的上下文压缩方案：
  - [Explore 的压缩与摘要持久化](./explore-ingest.md)
- 我想确认 `additional_kwargs`、`ToolMessage.artifact` 是否是长期协议：
  - [兼容与非持久元数据](./compatibility-notes.md)
