import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { config } from './config';
import { postTrends } from './apiClient';
import type { TrendPromptItem } from './capabilities/dailyPost';

export type CrawlerLogFn = (line: string) => void;

type XhsNoteItem = {
  note_id?: string;
  type?: string;
  title?: string;
  desc?: string;
  liked_count?: string | number;
  image_list?: string;
  tag_list?: string;
  note_url?: string;
  source_keyword?: string;
};

function splitQueryTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const parts = normalized
    .split(/[\s,\n，、;；|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return Array.from(new Set([normalized, ...parts])).slice(0, 8);
}

function matchesCrawlerQuery(item: XhsNoteItem, query: string): boolean {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return true;
  const haystack = [
    item.source_keyword,
    item.title,
    item.desc,
    item.tag_list,
    item.note_url,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
  if (!haystack) return false;
  return terms.some((term) => haystack.includes(term));
}

function emitCrawlerLog(log: CrawlerLogFn | undefined, line: string) {
  if (log) {
    log(line);
    return;
  }
  console.log(line);
}

function emitCrawlerError(log: CrawlerLogFn | undefined, line: string) {
  if (log) {
    log(line);
    return;
  }
  console.warn(line);
}

function emitChunkedLog(log: CrawlerLogFn | undefined, prefix: string, chunk: Buffer | string) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    emitCrawlerLog(log, `${prefix}${trimmed}`);
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLikedCount(raw: string | number | undefined): number {
  if (typeof raw === 'number') return Math.floor(raw);
  if (!raw) return 0;
  const s = String(raw).trim();
  if (s.endsWith('万')) return Math.floor(parseFloat(s) * 10000);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function xhsItemToTrendPromptItem(item: XhsNoteItem, index: number): TrendPromptItem {
  const likedCount = parseLikedCount(item.liked_count);
  const imageUrls = item.image_list
    ? item.image_list.split(',').map((u) => u.trim()).filter((u) => u.startsWith('http')).slice(0, 3)
    : null;
  return {
    id: item.note_id ?? `local-${index}`,
    platform: 'xhs',
    title: item.title!.trim(),
    summary: item.desc ? item.desc.slice(0, 300) : null,
    url: item.note_url ?? null,
    topic: item.tag_list ? (item.tag_list.split(',')[0]?.trim() ?? null) : null,
    score: Math.min(1, likedCount / 50000),
    likedCount,
    imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : null,
  };
}

function loadCrawlerJson(log?: CrawlerLogFn): XhsNoteItem[] {
  const dir = config.mediaCrawlerDir;
  if (!dir) return [];
  const now = new Date();
  const localToday = formatLocalDate(now);
  const localYesterday = formatLocalDate(new Date(now.getTime() - 86400000));
  const utcToday = now.toISOString().slice(0, 10);
  const utcYesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  for (const date of Array.from(new Set([localToday, localYesterday, utcToday, utcYesterday]))) {
    const filePath = resolve(dir, 'data', 'xhs', 'json', `search_contents_${date}.json`);
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const items = JSON.parse(raw) as XhsNoteItem[];
      emitCrawlerLog(log, `[crawler] loaded ${items.length} items from ${filePath}`);
      return items;
    } catch (err) {
      emitCrawlerError(log, `[crawler] failed to read JSON: ${err instanceof Error ? err.message : err}`);
    }
  }
  return [];
}

/** Read crawler JSON and return as TrendPromptItems directly (no DB write). */
export function readCrawlerResults(maxCount?: number, log?: CrawlerLogFn): TrendPromptItem[] {
  return limitTrendItems(
    loadCrawlerJson(log)
      .filter((item) => item.title?.trim())
      .map((item, i) => xhsItemToTrendPromptItem(item, i)),
    maxCount,
  );
}

export function readRelevantCrawlerResults(
  query: string,
  maxCount?: number,
  log?: CrawlerLogFn,
): TrendPromptItem[] {
  const filtered = loadCrawlerJson(log)
    .filter((item) => item.title?.trim())
    .filter((item) => matchesCrawlerQuery(item, query))
    .map((item, i) => xhsItemToTrendPromptItem(item, i));
  if (filtered.length > 0) {
    emitCrawlerLog(log, `[crawler] matched ${filtered.length} cached items for query="${query}"`);
  }
  return limitTrendItems(filtered, maxCount);
}

function limitTrendItems<T>(items: T[], maxCount?: number): T[] {
  if (!maxCount || maxCount <= 0) return items;
  return items.slice(0, maxCount);
}

/** Read crawler JSON and POST to /agent/trends (writes to DB). */
export async function ingestCrawlerResults(maxCount?: number, log?: CrawlerLogFn): Promise<void> {
  const items = limitTrendItems(
    loadCrawlerJson(log).filter((item) => item.title?.trim()),
    maxCount,
  );
  if (items.length === 0) {
    emitCrawlerLog(log, '[ingest] no crawler results to ingest');
    return;
  }

  const body = items.map((item) => ({
    title: item.title!.trim(),
    summary: item.desc ? item.desc.slice(0, 300) : undefined,
    url: item.note_url ?? undefined,
    topic: item.tag_list ? item.tag_list.split(',')[0]?.trim() : undefined,
    hot_score: Math.min(1, parseLikedCount(item.liked_count) / 50000),
    liked_count: parseLikedCount(item.liked_count),
    image_urls: item.image_list
      ? item.image_list.split(',').map((u) => u.trim()).filter((u) => u.startsWith('http')).slice(0, 3)
      : undefined,
    note_id: item.note_id,
  }));

  const result = await postTrends('xhs', body);
  emitCrawlerLog(log, `[ingest] accepted=${result.accepted} duplicates=${result.duplicates}`);
}

/** Use LLM to generate XHS search keywords based on the pet's personality and recent topics. */
export async function generateCrawlKeywords(params: {
  pet: { name: string; personality: string | null; species: string | null };
  recentTopics: string[];
  today: string;
}, log?: CrawlerLogFn): Promise<string[]> {
  const { pet, recentTopics, today } = params;
  const avoidText = recentTopics.length > 0
    ? `避免这些近期已发过的话题：${recentTopics.join('、')}。`
    : '';

  const prompt = [
    `今天是 ${today}。你是一只叫「${pet.name}」的${pet.species ?? '宠物'}，性格是「${pet.personality ?? '可爱'}」。`,
    `根据你对近期时事和热点话题的了解，生成 3 个适合在小红书上搜索的中文关键词，要求：`,
    `- 关键词具体、有话题性，贴近${pet.name}的性格和关注点`,
    `- ${avoidText}`,
    `只返回关键词，用英文逗号分隔，不要解释，例如：程序员副业,Python学习,转码经验`,
  ].join('\n');

  try {
    const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
    const completion = await client.chat.completions.create({
      model: config.llmModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 80,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    const keywords = text.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 3);
    if (keywords.length > 0) return keywords;
  } catch (err) {
    emitCrawlerError(log, `[crawler] keyword generation failed: ${err instanceof Error ? err.message : err}`);
  }
  return ['宠物日常', '萌宠'];
}

const CRAWLER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function runMediaCrawler(opts: { keywords: string[]; maxCount?: number; log?: CrawlerLogFn }): Promise<void> {
  const dir = config.mediaCrawlerDir;
  if (!dir) {
    emitCrawlerLog(opts.log, '[crawler] MEDIACRAWLER_DIR not set, skipping');
    return;
  }

  // Prefer venv python to pick up MediaCrawler's dependencies
  const venvPython = resolve(dir, '.venv', 'bin', 'python');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';

  const maxCount = opts.maxCount ?? 10;
  const keywordsArg = opts.keywords.join(',');
  emitCrawlerLog(opts.log, `[crawler] keywords: ${keywordsArg} | max: ${maxCount}`);

  // -u: force unbuffered stdout/stderr so we see output in real time when piped
  // --get_comment false: we only need trend titles/content, not comments
  // Login state is persisted in xhs_user_data_dir via Playwright persistent context.
  // Scan QR code on first run; subsequent runs reuse saved session automatically.
  const args = [
    '-u', 'main.py',
    '--get_comment', 'false',
    '--keywords', keywordsArg,
  ];
  emitCrawlerLog(opts.log, '[crawler] current MediaCrawler CLI does not support a notes-count flag; limiting results after crawl');
  emitCrawlerLog(opts.log, '[crawler] using saved session (scan QR code on first run)');

  return new Promise((resolve, reject) => {
    emitCrawlerLog(opts.log, `[crawler] starting MediaCrawler in ${dir}...`);

    const proc = spawn(pythonBin, args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (data: Buffer) => emitChunkedLog(opts.log, '[crawler] ', data));
    proc.stderr.on('data', (data: Buffer) => emitChunkedLog(opts.log, '[crawler:err] ', data));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`MediaCrawler timed out after ${CRAWLER_TIMEOUT_MS / 1000}s`));
    }, CRAWLER_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        emitCrawlerLog(opts.log, '[crawler] done');
        resolve();
      } else {
        reject(new Error(`MediaCrawler exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`MediaCrawler failed to start: ${err.message}`));
    });
  });
}
