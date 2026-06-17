import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { ToolkitOperationMetadata } from '@pinpawo/pet-agent';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import {
  readNumber,
  readRecord,
  readString,
} from '../operationMetadata';
import { resolveUserPath } from './pathUtils';

const DEFAULT_MAX_CHARS = 30_000;
const MAX_MAX_CHARS = 100_000;
const MIN_MAX_CHARS = 1_000;

type PdfTextItem = {
  str: string;
  hasEOL: boolean;
};

type PdfTextMarkedContent = {
  type: string;
};

function clampMaxChars(maxChars?: number) {
  if (!Number.isFinite(maxChars ?? DEFAULT_MAX_CHARS)) {
    return DEFAULT_MAX_CHARS;
  }
  return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.floor(maxChars ?? DEFAULT_MAX_CHARS)));
}

function isTextItem(item: PdfTextItem | PdfTextMarkedContent): item is PdfTextItem {
  return 'str' in item;
}

function textItemsToString(items: Array<PdfTextItem | PdfTextMarkedContent>) {
  const chunks: string[] = [];
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const text = item.str.trim();
    if (text) chunks.push(text);
    if (item.hasEOL) chunks.push('\n');
  }
  return chunks
    .join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePageRange(totalPages: number, startPage?: number, endPage?: number) {
  const start = Math.max(1, Math.floor(startPage ?? 1));
  const end = Math.min(totalPages, Math.floor(endPage ?? totalPages));
  if (end < start) {
    throw new Error(`invalid page range ${start}-${end}; PDF has ${totalPages} page(s)`);
  }
  return { start, end };
}

export const readPdfTool = tool(
  async ({ path, startPage, endPage, maxChars }: {
    path: string;
    startPage?: number;
    endPage?: number;
    maxChars?: number;
  }) => {
    const filePath = resolveUserPath(path);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return `Error: read_pdf expects a file path, got ${stat.isDirectory() ? 'directory' : 'non-file'}: ${filePath}`;
      }

      if (extname(filePath).toLowerCase() !== '.pdf') {
        return `Error: read_pdf expects a .pdf file: ${filePath}`;
      }

      const data = new Uint8Array(readFileSync(filePath));
      if (data.byteLength < 5 || Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') {
        return `Error: file does not look like a PDF: ${filePath}`;
      }

      const limit = clampMaxChars(maxChars);
      const loadingTask = getDocument({
        data,
        disableFontFace: true,
        useSystemFonts: true,
      });
      const pdf = await loadingTask.promise;

      try {
        const { start, end } = normalizePageRange(pdf.numPages, startPage, endPage);
        const pages: Array<{ page: number; text: string }> = [];
        let collectedChars = 0;
        let truncated = false;

        for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const pageText = textItemsToString(content.items);
          const remaining = limit - collectedChars;
          const text = pageText.length > remaining
            ? pageText.slice(0, Math.max(0, remaining))
            : pageText;

          pages.push({ page: pageNumber, text });
          collectedChars += text.length;

          if (pageText.length > text.length || (collectedChars >= limit && pageNumber < end)) {
            truncated = true;
            break;
          }
        }

        return JSON.stringify({
          ok: true,
          path: filePath,
          totalPages: pdf.numPages,
          startPage: start,
          endPage: pages.at(-1)?.page ?? start,
          maxChars: limit,
          truncated,
          pages,
        }, null, 2);
      } finally {
        await pdf.destroy();
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'read_pdf',
    description: '读取本地 PDF 文档文本，支持指定页码范围和最大返回字符数。适合论文、报告、合同等 PDF 的文本抽取；扫描件或图片型 PDF 可能返回空文本，需要 OCR 工具另行处理。',
    schema: z.object({
      path: z.string().describe('PDF 文件路径；支持绝对路径、相对工作目录路径或 ~/ 路径'),
      startPage: z.number().int().positive().optional().describe('起始页码，默认 1'),
      endPage: z.number().int().positive().optional().describe('结束页码，默认文档最后一页'),
      maxChars: z.number().int().positive().optional().describe('最大返回字符数，默认 30000，上限 100000'),
    }),
  },
);

export const pdfOperationMetadata: Record<string, ToolkitOperationMetadata> = {
  read_pdf: {
    title: '读PDF',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      return target
        ? {
            target,
            details: {
              startPage: readNumber(record, 'startPage'),
              endPage: readNumber(record, 'endPage'),
              maxChars: readNumber(record, 'maxChars'),
            },
          }
        : null;
    },
  },
};
