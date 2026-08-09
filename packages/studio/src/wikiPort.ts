import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';

import type { StudioTaskQueueItem } from './types';

/**
 * Wiki port —— Studio 声明它需要什么,不关心谁实现。
 *
 * 实现住在 toolkit 层(例如 `@pinpawo-toolkit/studio-kanban` 的文件实现),
 * 由宿主注入。这样看板可以换成 S3 / DB 实现而不动编排核心,也让本包保持
 * 不碰 FS。
 */

export type StudioWikiTaskSource = StudioTaskQueueItem & {
  resultText?: string;
};

export type WikiCurateInput = {
  wikiRoot: string;
  task: StudioWikiTaskSource;
};

export type WikiCurateResult = {
  changedPaths: string[];
};

/**
 * Curator:接收一次 worker task completion,产出 wiki 更新。
 *
 * 编排核心只依赖这个接口;素材落档、LLM 整理、index 重写等策略差异
 * 全部由实现决定。
 */
export type WikiCurator = {
  curate: (input: WikiCurateInput) => Promise<WikiCurateResult>;
};

/**
 * Wiki 存储的初始化钩子。orchestrator 在开一个 run 前调用一次,
 * 让实现有机会建目录骨架 / 建 bucket 前缀 / 建表。
 */
export type WikiSkeletonInitializer = (wikiRoot: string) => Promise<void>;

/**
 * 不落盘的默认实现:什么都不做,curate 永远报告无变更。
 *
 * 让 orchestrator 在**没有注入 wiki 实现**时仍可运行(测试、纯编排场景)。
 * 生产环境由宿主注入真正的实现。
 */
export function createNoopWikiCurator(): WikiCurator {
  return {
    curate: async () => ({ changedPaths: [] }),
  };
}

export const noopWikiSkeletonInitializer: WikiSkeletonInitializer = async () => {};

/**
 * Pet 侧的 wiki 访问。pet runtime 需要在 invoke 时:
 * - 读知识库索引,注入 system prompt;
 * - 装备检索工具,让 pet 能自己查。
 *
 * 两者都由实现提供,编排核心不知道背后是文件、S3 还是数据库。
 */
export type StudioWikiAccess = {
  /** 知识库索引内容;不存在时返回 null,由调用方降级处理。 */
  readIndex: (wikiRoot: string) => Promise<string | null>;
  createReadToolkit: (wikiRoot: string) => AgentToolkit;
  createReadCapability: () => AgentCapability;
  /** 用于判断调用方是否已自带同名 capability,避免重复注入。 */
  readCapabilityName: string;
};
