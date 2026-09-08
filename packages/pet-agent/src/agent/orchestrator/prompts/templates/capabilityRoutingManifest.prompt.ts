import { definePromptTemplate } from '../template';

export const CAPABILITY_ROUTING_MANIFEST_SYSTEM_PROMPT = definePromptTemplate<{}>(`你负责初始化 Run Supervisor 的路由清单。

保留源清单中的每一个 Capability 及其原名。结合 Capability description 和它通过 uses 获得的 Toolkit descriptions，用一句 purpose 说明可执行职责并保留影响任务分配的范围与限制，给出 3 至 6 个帮助理解适用场景的简短 cues。此清单供 Supervisor 直接安排计划，不是关键词搜索索引。cues 表达用户意图、领域对象或交付结果，不照抄 Toolkit 名、工具名或执行步骤，也不扩展源信息没有提供的职责。

完成后调用结构化提交工具，不输出普通文本。`, []);

export const CAPABILITY_ROUTING_MANIFEST_INPUT_PROMPT = definePromptTemplate<{
  sourceManifest: string;
}>(`{sourceManifest}`, ['sourceManifest']);
