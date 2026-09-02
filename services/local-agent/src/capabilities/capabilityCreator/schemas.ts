import { z } from 'zod';

export const scaffoldCapabilityPluginInputSchema = z.object({
  id: z.string().trim().min(1).describe('稳定 capability id。建议使用 snake_case，例如 capability_creator'),
  name: z.string().trim().min(1).describe('展示名称，通常是中文名'),
  description: z.string().trim().min(1).describe('用于 Supervisor 检索和选择的一句话职责描述，应包含用户会说的关键词'),
  task: z.string().trim().min(1).describe('可复用的 capability 职责和执行目标，不要写成只适用于当前请求的一次性任务'),
  uses: z.array(z.string().trim().min(1))
    .max(16)
    .refine((items) => new Set(items).size === items.length, '不能包含重复 Toolkit')
    .optional()
    .describe('完整 Toolkit 权限边界；默认 ["bash"]，不需要工具时传 []'),
  workflow: z.array(z.string().trim().min(1)).max(12).optional()
    .describe('面向实际任务的有序执行步骤'),
  boundaries: z.array(z.string().trim().min(1)).max(12).optional()
    .describe('明确不负责的场景、禁止操作和降级条件'),
  outputRequirements: z.array(z.string().trim().min(1)).max(12).optional()
    .describe('结果必须包含的字段、格式、证据或验证要求'),
  icon: z.string().trim().min(1).optional().describe('CAPABILITY.md frontmatter 图标名，默认 wand.and.stars'),
  color: z.string().trim().min(1).optional().describe('CAPABILITY.md frontmatter 颜色 token，默认 purple'),
  rootDir: z.string().trim().min(1).optional().describe('目标 capability 目录；默认 ~/.pinpawo/capabilities/<id>'),
  overwrite: z.boolean().optional().describe('目标文件已存在时是否覆盖，默认 false'),
  includePackageJson: z.boolean().optional().describe('是否生成 package.json，默认 true'),
  includeReadme: z.boolean().optional().describe('是否生成 README.md，默认 true'),
  includeSmokeTest: z.boolean().optional().describe('是否生成 index.test.mjs 文档冒烟测试，默认 true'),
});

export const validateCapabilityPluginInputSchema = z.object({
  rootDir: z.string().describe('capability 插件目录'),
});

export const capabilityCreatorResultSchema = z.object({
  status: z.enum(['created', 'validated', 'failed']),
  capabilityId: z.string().nullable(),
  rootDir: z.string().nullable(),
  files: z.array(z.string()),
  note: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
});

export type CapabilityCreatorResult = z.infer<typeof capabilityCreatorResultSchema>;
