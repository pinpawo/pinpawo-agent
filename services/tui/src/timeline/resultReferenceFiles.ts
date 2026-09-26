import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentResultReference } from '@pinpawo/agent-session';

/** Local Markdown evidence files, linked from immutable terminal scrollback. */
export class ResultReferenceFiles {
  private directory: string | null = null;
  private urls = new Map<string, string>();

  constructor(private readonly tempRoot = tmpdir()) {}

  url(reference: AgentResultReference): string {
    const key = createHash('sha256').update(JSON.stringify(reference)).digest('hex');
    const existing = this.urls.get(key);
    if (existing) return existing;
    this.directory ??= mkdtempSync(path.join(this.tempRoot, 'pinpawo-results-'));
    const filePath = path.join(this.directory, `${key}.md`);
    writeFileSync(filePath, reference.text, { encoding: 'utf8', mode: 0o600 });
    const url = pathToFileURL(filePath).href;
    this.urls.set(key, url);
    return url;
  }
}

export const resultReferenceFiles = new ResultReferenceFiles();
