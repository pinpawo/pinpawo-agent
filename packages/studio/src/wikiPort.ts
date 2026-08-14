import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';

/**
 * Wiki port —— Studio 声明 pet 需要什么样的知识库入口,不关心谁实现。
 *
 * 实现住在 toolkit 层(例如 `@pinpawo-toolkit/studio-kanban` 的文件实现),
 * 由宿主注入。这样知识库可以换成 S3 / DB 实现而不动这里,也让本包保持不碰 FS。
 *
 * 注意这里**只有读**。往知识库写是插件自己的事:pet 完成后经 event 汇报,
 * 由订阅事件的插件决定要不要落档、怎么整理。推模型下 studio 不在回路上,
 * 所以曾经的 curator / skeleton 钩子已随旧 orchestrator 一并删除。
 */

/**
 * Pet 侧的 wiki 访问。pet runtime 需要在 invoke 时:
 * - 读知识库索引,注入 system prompt;
 * - 装备检索工具,让 pet 能自己查。
 *
 * 两者都由实现提供,studio 不知道背后是文件、S3 还是数据库。
 */
export type StudioWikiAccess = {
  /** 知识库索引内容;不存在时返回 null,由调用方降级处理。 */
  readIndex: (wikiRoot: string) => Promise<string | null>;
  createReadToolkit: (wikiRoot: string) => AgentToolkit;
  createReadCapability: () => AgentCapability;
  /** 用于判断调用方是否已自带同名 capability,避免重复注入。 */
  readCapabilityName: string;
};
