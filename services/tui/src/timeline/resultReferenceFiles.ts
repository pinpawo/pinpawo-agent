import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentResultReference } from '@pinpawo/agent-session';

/** Local read-only evidence pages, linked from immutable terminal scrollback. */
export class ResultReferenceFiles {
  private directory: string | null = null;
  private urls = new Map<string, string>();

  constructor(private readonly tempRoot = tmpdir()) {}

  url(reference: AgentResultReference): string {
    const key = createHash('sha256').update(JSON.stringify(reference)).digest('hex');
    const existing = this.urls.get(key);
    if (existing) return existing;
    this.directory ??= mkdtempSync(path.join(this.tempRoot, 'pinpawo-results-'));
    const filePath = path.join(this.directory, `${key}.html`);
    writeFileSync(filePath, resultReferenceHtml(reference), { encoding: 'utf8', mode: 0o600 });
    const url = pathToFileURL(filePath).href;
    this.urls.set(key, url);
    return url;
  }
}

export function resultReferenceHtml(reference: AgentResultReference) {
  // Treat every byte of model output as text. No scripts, remote resources,
  // raw HTML, or model-supplied links are executed by the evidence viewer.
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(reference.title || '执行结果')}</title>
<style>body{color:#252a30;background:#fafafa;font:16px/1.65 system-ui,sans-serif;max-width:880px;margin:48px auto;padding:0 24px}h1{font-size:24px}header{color:#647079;font-size:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;border-top:1px solid #ddd;padding-top:24px}</style>
<header>执行结果 · Capability 交付原文</header>
<h1>${escapeHtml(reference.title || '执行结果')}</h1>
<pre>${escapeHtml(reference.text)}</pre></html>`;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export const resultReferenceFiles = new ResultReferenceFiles();
