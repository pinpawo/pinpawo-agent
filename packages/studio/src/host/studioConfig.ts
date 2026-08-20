import { promises as fs } from 'node:fs';

import { parseConfigDocument } from '@pinpawo/pet-agent';
import {
  resolveStudio,
  studioLocalConfigSchema,
  type ResolvedStudio,
  type StudioLocalConfig,
} from '../configSchema';

export { resolveStudio };
export type { ResolvedStudio, StudioLocalConfig };

/**
 * 文件入口:studio 配置住在 `<workdir>/.pinpawo/studio.json`,一个 workdir 一份。
 *
 * schema 与引用一致性校验归 Studio core；本模块只负责去哪读。
 */

/**
 * 从指定路径加载 studio config。
 * - 文件不存在 → 返回 null(caller 自行决定要不要报错)
 * - JSON 无法解析或 schema 不合法 → 抛错
 */
export async function loadStudioLocalConfig(filePath: string): Promise<StudioLocalConfig | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseConfigDocument({
    content,
    source: filePath,
    schema: studioLocalConfigSchema,
  });
}
