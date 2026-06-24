# Pet Agent API 概览

## 版本信息

- 日期：`2026-06-25`
- 目标：`packages/pet-agent` 与 `services/local-agent` 的接口边界
- 适用：Open Source 公开文档版本（代码行为请以实现为准）

## API 形态

1. **编程 API**
   - `packages/pet-agent` 提供运行时/类型导出
   - `createPetAgentRuntime`
   - `createStudioOrchestrator`
2. **命令 API**
   - `pinpawo-agent` CLI
   - `capability` 子命令
3. **扩展协议**
   - 用户能力插件（manifest + index.js）
   - toolkit/capability 运行时契约

## 核心边界

1. `PetAgentRuntime` 负责：单宠执行、模型调用、工具执行、HITL 消费
2. `StudioOrchestrator` 负责：planner + execute 状态机 + wiki_curator 调度
3. `Capability / Toolkit` 负责：技能逻辑与工具能力
4. `Local Agent` 负责：CLI、运行时加载、能力扫描与安装

## 快速入口

1. 想接调用 runtime -> [Pet Runtime API](PET_AGENT_API_PET_RUNTIME.md#1-入口)
2. 想接 orchestrator -> [Studio Orchestrator API](PET_AGENT_API_STUDIO_ORCHESTRATOR.md#1-入口)
3. 想接能力接口 -> [能力与工具契约](PET_AGENT_API_CAPABILITY_TOOLKIT.md#1-能力定义)
4. 想接工具事件/HITL -> [工具事件与 HITL](PET_AGENT_API_EVENTS_HITL.md#1-事件类型)
5. 想写插件 -> [能力插件协议](PET_AGENT_API_PLUGIN_PROTOCOL.md#1-插件结构)
6. 想排错 -> [错误与观察性](PET_AGENT_API_ERROR_HANDLING.md#1-错误分类)
