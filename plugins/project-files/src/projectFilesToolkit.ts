import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { AuthorizationPolicies, defineToolkit, ReviewPolicies, type AgentToolkit, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { projectDocumentDigest, ProjectFilesService, readDocumentPath } from './projectFilesService';

/** A generic Markdown knowledge Toolkit, scoped to one configured Project Files root. */
export function createProjectFilesToolkit(service: ProjectFilesService): AgentToolkit {
  const root = service.canonicalRoot;
  const list = tool(async () => JSON.stringify({ documents: await service.listDocuments() }), {
    name: 'project_files_list',
    description: '列出 Studio 共享知识目录中的 Markdown 页面。',
    schema: z.object({}),
  });
  const read = tool(async ({ path: documentPath }) => {
    const document = await service.readDocument(documentPath);
    return JSON.stringify({ document: document ? { ...document, digest: projectDocumentDigest(document.content) } : null });
  }, {
    name: 'project_files_read',
    description: '按相对路径读取共享 Markdown；结果含 digest，写入前必须读取。文件不存在时返回 null。',
    schema: z.object({ path: z.string().min(1) }),
  });
  const write = tool(async ({ path: documentPath, content, expectedDigest }) => JSON.stringify(
    await service.writeDocument(documentPath, content, expectedDigest, root),
  ), {
    name: 'project_files_write',
    description: '创建或更新共享 Markdown。先读取并保留已有内容；expectedDigest 使用读取返回值，新建文件用 null。发现冲突时重新读取，不覆盖他人的改动。',
    schema: z.object({
      path: z.string().min(1),
      content: z.string(),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }),
  });
  const writeOperation: ToolOperationMetadata = {
    title: '更新项目知识',
    summarize: (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
      const { path: documentPath, content, expectedDigest } = input as Record<string, unknown>;
      if (typeof documentPath !== 'string' || typeof content !== 'string') return null;
      let validatedPath: string;
      try {
        validatedPath = readDocumentPath(documentPath);
      } catch {
        return null;
      }
      return {
        target: path.resolve(root, validatedPath),
        summary: expectedDigest === null ? '创建 Markdown 文档' : '更新 Markdown 文档',
        blocks: [{ kind: 'text', label: '写入内容', text: content }],
      };
    },
  };
  return defineToolkit({
    name: 'project_files',
    description: '读取和维护 Studio 配置的项目 Markdown 知识目录。',
    instructions: '知识页面路径均相对于 Studio 配置的知识目录。更新前用 project_files_read 读取并保留现有内容，写入时携带 digest；并发冲突时重新读取。',
    tools: [
      { tool: list, operation: { title: '列出项目知识' } },
      { tool: read, operation: { title: '读取项目知识' } },
      { tool: write, operation: writeOperation, review: ReviewPolicies.required({
        authorization: AuthorizationPolicies.exact({
          subject: ({ input }) => ({ root, input }),
          reuseAutoReview: true,
        }),
      }) },
    ],
  });
}
