import { z } from 'zod';

export const scaffoldCapabilityPluginInputSchema = z.object({
  id: z.string().min(1).describe('稳定 capability id。建议使用 snake_case，例如 capability_creator'),
  name: z.string().min(1).describe('展示名称，通常是中文名'),
  description: z.string().min(1).describe('一句话说明这个 capability 负责什么'),
  task: z.string().min(1).describe('这次要为用户实现的 capability 目标或需求摘要'),
  icon: z.string().optional().describe('manifest 图标名，默认 wand.and.stars'),
  color: z.string().optional().describe('manifest 颜色 token，默认 purple'),
  rootDir: z.string().optional().describe('目标目录；默认 ~/.pinpawo/capabilities/<id>'),
  overwrite: z.boolean().optional().describe('目标文件已存在时是否覆盖，默认 false'),
  includePackageJson: z.boolean().optional().describe('是否生成 package.json，默认 true'),
  includeReadme: z.boolean().optional().describe('是否生成 README.md，默认 true'),
  includeSmokeTest: z.boolean().optional().describe('是否生成 index.test.mjs 冒烟测试，默认 true'),
});

export const validateCapabilityPluginInputSchema = z.object({
  rootDir: z.string().describe('capability 插件目录'),
});

export const checkCapabilityKeywordsInputSchema = z.object({
  rootDir: z.string().optional().describe('capability 插件目录；提供后会读取 manifest.json 和 index.js'),
  name: z.string().optional().describe('不读取目录时手动提供 capability name'),
  description: z.string().optional().describe('不读取目录时手动提供 capability description'),
  queries: z.array(z.string().min(1)).optional().describe('用于检查的用户自然语言 query，例如“根据最新热点生成三条视频脚本”'),
});

const keywordCheckSchema = z.object({
  query: z.string(),
  matched: z.boolean(),
  topCandidate: z.string().nullable(),
  score: z.number().nullable(),
  matchedTerms: z.array(z.string()),
});

export const capabilityCreatorResultSchema = z.object({
  status: z.enum(['created', 'validated', 'failed']),
  capabilityId: z.string().nullable(),
  rootDir: z.string().nullable(),
  files: z.array(z.string()),
  note: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  keywordChecks: z.array(keywordCheckSchema).optional(),
  suggestedDescriptionTerms: z.array(z.string()).optional(),
});

export type CapabilityCreatorResult = z.infer<typeof capabilityCreatorResultSchema>;
