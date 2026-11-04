# Capability Artifact Pipeline

> **状态：历史实现。** 本目录记录清理前的 Capability Artifact Pipeline，源码基线为
> [`b4f0430c`](https://github.com/pinpawo/pinpawo-agent/tree/b4f0430c7b79219e31980397ed7c0e2917b1592a/docs/reference/artifacts)。
> 旧 store、discovery Toolkit 和 finalize 写入接口已退役；当前实施边界见
> [退役说明](../../../reference/extensions/capability-toolkit.md#7-旧-artifact-pipeline-退役)。
>
> 用途：保留旧管线从 `run` 到 `artifact store` 到主流程引用的实现资料。

## 文档结构

1. [架构概览](architecture.md)
2. [持久化契约](store-contract.md)
3. [兼容与非持久元数据](compatibility-notes.md)

## 关注点快速入口

- 我想确认“这次 run 的 artifact 怎么流转？”看：
  - [架构概览](architecture.md)
- 我想知道每个文件字段和接口是什么：
  - [持久化契约](store-contract.md)
- 我想确认 `additional_kwargs`、`ToolMessage.artifact` 是否是长期协议：
  - [兼容与非持久元数据](compatibility-notes.md)
