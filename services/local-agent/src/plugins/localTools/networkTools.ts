import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { ToolkitOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import {
  okOutputPathSummary,
  readRecord,
  readString,
} from './operationMetadata';

const DEFAULT_DOWNLOADS_DIR = resolve(homedir(), 'Downloads');
const MAX_FETCH_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 15_000;

export function sanitizeFilename(filename: string) {
  return filename.replace(/[\\/:*?"<>|]/g, '_').trim() || `download-${Date.now()}`;
}

export function inferFilename(
  url: string,
  explicitFilename?: string | null,
  contentType?: string | null,
) {
  if (explicitFilename?.trim()) {
    return sanitizeFilename(explicitFilename.trim());
  }

  try {
    const pathname = new URL(url).pathname;
    const base = basename(pathname);
    if (base && extname(base)) {
      return sanitizeFilename(base);
    }
    if (base) {
      const ext = contentType?.includes('image/jpeg')
        ? '.jpg'
        : contentType?.includes('image/png')
          ? '.png'
          : contentType?.includes('image/webp')
            ? '.webp'
            : contentType?.includes('image/gif')
              ? '.gif'
              : '';
      return sanitizeFilename(`${base}${ext}`);
    }
  } catch {
    // ignore URL parse failure
  }

  const ext = contentType?.includes('image/jpeg')
    ? '.jpg'
    : contentType?.includes('image/png')
      ? '.png'
      : contentType?.includes('image/webp')
        ? '.webp'
        : contentType?.includes('image/gif')
          ? '.gif'
          : '';
  return `download-${Date.now()}${ext}`;
}

/** Strip HTML to readable plain text — removes scripts/styles, collapses tags to whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|nav|main)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const httpFetchTool = tool(
  async ({ url, method, headers, body, format }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    format?: 'text' | 'json' | 'raw';
  }) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method: method ?? 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/json,*/*',
            ...headers,
          },
          body: body ?? undefined,
          redirect: 'follow',
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const rawText = await response.text();
      const truncated = rawText.slice(0, MAX_FETCH_BYTES);

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}\n${truncated.slice(0, 500)}`;
      }

      const resolvedFormat = format
        ?? (contentType.includes('json') ? 'json' : 'text');

      if (resolvedFormat === 'json') {
        try {
          return JSON.stringify(JSON.parse(truncated), null, 2).slice(0, 8000);
        } catch {
          return truncated.slice(0, 8000);
        }
      }

      if (resolvedFormat === 'raw') {
        return truncated.slice(0, 8000);
      }

      // 'text': strip HTML tags for readability
      const text = contentType.includes('html') ? htmlToText(truncated) : truncated;
      return text.slice(0, 8000) || '(empty response)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'http_fetch',
    description: '通过 HTTP 请求获取网页或 API 内容，不会打开浏览器窗口，也不会复用浏览器登录态。适合不依赖 JS 渲染的页面、REST API、RSS 等。HTML 响应默认自动去除标签返回纯文本；JSON 响应格式化返回；传 format="raw" 返回原始内容。不支持需要登录态、页面交互或 JS 动态加载的页面；这类任务应交给浏览器 capability。',
    schema: z.object({
      url: z.string().url().describe('目标 URL'),
      method: z.string().optional().describe('HTTP 方法，默认 GET'),
      headers: z.record(z.string()).optional().describe('自定义请求头，如 Cookie、Authorization 等'),
      body: z.string().optional().describe('请求体，POST 时使用'),
      format: z.enum(['text', 'json', 'raw']).optional().describe('返回格式：text=去除 HTML 标签的纯文本（默认），json=格式化 JSON，raw=原始内容'),
    }),
  },
);

export const downloadFileTool = tool(
  async ({ url, filename }: { url: string; filename?: string }) => {
    try {
      mkdirSync(DEFAULT_DOWNLOADS_DIR, { recursive: true });
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'PinPawo Local Agent/1.0',
        },
      });
      if (!response.ok) {
        return `Error: download failed with status ${response.status}`;
      }
      const contentType = response.headers.get('content-type');
      const targetFilename = inferFilename(url, filename, contentType);
      const filePath = resolve(DEFAULT_DOWNLOADS_DIR, targetFilename);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      return JSON.stringify({
        ok: true,
        path: filePath,
        bytes: buffer.byteLength,
        contentType,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'download_file',
    description: '从 URL 下载文件到本机 Downloads 目录。适合下载图片或页面里提取到的资源链接，不要再用 shell/curl 做下载。',
    schema: z.object({
      url: z.string().url().describe('要下载的文件 URL'),
      filename: z.string().optional().describe('可选的保存文件名；不传则自动推断'),
    }),
  },
);

export const networkToolOperations: Record<string, ToolkitOperationMetadata> = {
  http_fetch: {
    kind: 'network.http_fetch',
    title: '请求网页',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'url'),
        details: { method: readString(record, 'method') ?? 'GET' },
      };
    },
  },
  download_file: {
    kind: 'file.download',
    title: '下载文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'url'),
        summary: readString(record, 'filename'),
      };
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
};
