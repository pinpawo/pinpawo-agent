/**
 * @deprecated This command is scheduled for removal.
 * The "once" flow (crawl → generate daily post → exit) will be replaced by
 * the TUI-based scheduled workflow which supports HITL and checkpointing.
 */

import { loadAgentContext, sendHeartbeat } from '../contextLoader';
import { runMediaCrawler, ingestCrawlerResults, readCrawlerResults, generateCrawlKeywords } from '../crawler';
import {
  dailyPostResultSchema,
  type DailyPostPayload,
  type DailyPostResult,
} from '../capabilities/dailyPost';
import { config } from '../config';
import { loadPlugins, collectPluginHooks } from '../pluginLoader';
import { buildLocalLlmConfig } from '../llmConfig';
import { buildLocalScheduledAgentInput } from '../agentChannel';
import { LocalAgentGraphService } from '../agentGraphService';
import { ensureActorSelected } from '../actorSelection';

export async function runOnce(opts: { dryRun: boolean; noDb: boolean }) {
  const actorId = await ensureActorSelected({ interactive: true });
  console.log(`[once] dry-run=${opts.dryRun}`);
  const { plugins: externalPlugins } = await loadPlugins();
  const hooks = collectPluginHooks(externalPlugins);
  if (externalPlugins.length > 0) {
    console.log(`[once] plugins: ${externalPlugins.map((plugin) => plugin.name).join(', ')}`);
  }

  // 1. Heartbeat
  console.log('[once] sending heartbeat...');
  await sendHeartbeat(actorId);
  console.log('[once] heartbeat ok');

  // 2. Load context first (needed for keyword generation)
  console.log('[once] loading context via GraphQL...');
  const ctx = await loadAgentContext(actorId);
  console.log(`[once] pet: ${ctx.pet.name} (${ctx.pet.species ?? '?'})`);
  console.log(`[once] memories: ${ctx.context.petMemoryText.split('\n').filter(Boolean).length} lines`);
  console.log(`[once] recent posts: ${ctx.context.recentDaily.length}`);

  // 3. Generate LLM-based keywords + run MediaCrawler
  const recentTopics = ctx.context.recentDaily.slice(0, 5).map((p) => p.topic).filter((t): t is string => Boolean(t));
  const crawlKeywords = await generateCrawlKeywords({
    pet: { name: ctx.pet.name, personality: ctx.pet.personality ?? null, species: ctx.pet.species ?? null },
    recentTopics,
    today: ctx.context.today,
  });
  console.log(`[once] crawl keywords: ${crawlKeywords.join(', ')}`);

  try {
    await hooks.beforeCrawl();
    await runMediaCrawler({ keywords: crawlKeywords, maxCount: 10 });
  } catch (err) {
    console.warn('[once] crawler failed, continuing with existing trends:', err instanceof Error ? err.message : err);
  }

  // Determine trend items: --no-db reads directly from crawler JSON, default ingests to DB first
  let trendItems = ctx.context.trendItems;
  if (opts.noDb) {
    trendItems = readCrawlerResults(10);
    console.log(`[once] --no-db: loaded ${trendItems.length} trend items from crawler JSON`);
  } else {
    try {
      await ingestCrawlerResults(10);
    } catch (err) {
      console.warn('[once] ingest failed, continuing with existing trends:', err instanceof Error ? err.message : err);
    }
    // Reload context after ingest so trendItems reflects what was just written
    const refreshed = await loadAgentContext(actorId);
    trendItems = refreshed.context.trendItems;
  }

  console.log(`[once] trend items: ${trendItems.length}`);
  for (const t of trendItems) {
    console.log(`  - [${t.platform}] ${t.title}`);
  }

  // 4. Build adapters — swap savePost for dry-run stub if needed
  // 5. Run agent
  console.log('\n[once] running agent...');
  const llmConfig = buildLocalLlmConfig({
    verbose: true,
    timeoutMs: 120000,
  });
  const setup = buildLocalScheduledAgentInput({
    context: {
      ...ctx,
      context: {
        ...ctx.context,
        trendItems,
      },
    },
    llmConfig,
    dryRun: opts.dryRun,
    dailyPost: opts.dryRun
      ? {
          savePost: async (params: {
            payload: DailyPostPayload;
          }): Promise<{ postId: string | null }> => {
            console.log('\n[dry-run] savePost called — NOT writing to DB');
            console.log('[dry-run] content:', params.payload.content);
            console.log('[dry-run] mood:', params.payload.mood);
            console.log('[dry-run] topic:', params.payload.topic);
            console.log('[dry-run] tags:', params.payload.tags);
            console.log('[dry-run] citations:', params.payload.citations);
            if (params.payload.image?.prompt) {
              console.log('[dry-run] image.prompt:', params.payload.image.prompt);
            }
            return { postId: 'dry-run-no-id' };
          },
          markUsed: async (trendItemId: string) => {
            console.log(`[dry-run] markUsed: ${trendItemId}`);
          },
          markSkipped: async (trendItemId: string, reason: string) => {
            console.log(`[dry-run] markSkipped: ${trendItemId} reason=${reason}`);
          },
        }
      : undefined,
  });

  const graphService = new LocalAgentGraphService();
  const { result: structuredResult } = await graphService.invokeStructuredResult(
    setup,
    dailyPostResultSchema,
  );
  const result: DailyPostResult = structuredResult
    ? structuredResult as DailyPostResult
    : { status: 'skipped', postId: null, reason: 'no-post', payload: null, imageRequested: false };

  console.log(`\n[once] result: status=${result.status}${result.postId ? ` postId=${result.postId}` : ''}${result.reason ? ` reason=${result.reason}` : ''}`);

  if (result.status === 'created' && result.postId && result.payload) {
    await hooks.afterPostSaved(result.postId, result.payload);
  }
}
