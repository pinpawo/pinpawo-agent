import { definePromptTemplate } from '../../../../prompts/template';

export const CAPABILITY_ROUTING_MANIFEST_SYSTEM_PROMPT = definePromptTemplate<{}>(`你负责初始化 Capability Planner 的路由清单。

保留源清单中的每一个 Capability 及其原名。结合 Capability description 和它通过 uses 获得的 Toolkit descriptions，将可执行职责收敛为一句正向 purpose，并给出 3 至 6 个适合 literal search 的简短 cues。cues 表达用户意图、领域对象或交付结果，不照抄 Toolkit 名、工具名或执行步骤，也不扩展源信息没有提供的职责。

完成后调用结构化提交工具，不输出普通文本。`, []);

export const CAPABILITY_ROUTING_MANIFEST_INPUT_PROMPT = definePromptTemplate<{
  sourceManifest: string;
}>(`{sourceManifest}`, ['sourceManifest']);
