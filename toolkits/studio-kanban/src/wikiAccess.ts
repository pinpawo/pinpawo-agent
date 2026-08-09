import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { StudioWikiAccess } from '@pinpawo/studio';

import { createWikiReadCapability, WIKI_READ_CAPABILITY_NAME } from './wikiReadCapability';
import { createWikiReadToolkit } from './wikiReadToolkit';

/**
 * 文件实现的 `StudioWikiAccess`,注入给 pet runtime。
 *
 * 编排核心只知道这个接口;"索引住在 {wikiRoot}/index.md" 是本实现的私事,
 * 换 S3/DB 实现时编排核心不用改。
 */
export function createFileWikiAccess(): StudioWikiAccess {
  return {
    // 索引缺失是正常状态(知识库还没生成),返回 null 让调用方降级。
    readIndex: async (wikiRoot: string) => {
      try {
        return await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8');
      } catch {
        return null;
      }
    },
    createReadToolkit: (wikiRoot: string) => createWikiReadToolkit(wikiRoot),
    createReadCapability: () => createWikiReadCapability(),
    readCapabilityName: WIKI_READ_CAPABILITY_NAME,
  };
}
