import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrowserSession } from '../src/toolkits/browser/session';
import { startBrowserScenarioFixture } from './browser-scenario-fixture';

type Snapshot = {
  title: string;
  url: string;
  text: string;
  interactive: Array<{ ref?: string; placeholder: string | null; hint: string }>;
};
type Extract = { text: string; textLength: number; returnedTextLength: number; hasMore: boolean; nextOffset: number | null };

const profileDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-popup-smoke-'));
const browser = new BrowserSession();
const fixture = await startBrowserScenarioFixture();

type BrowserSessionInternals = {
  impl: {
    context: {
      newPage(): Promise<{ goto(url: string): Promise<unknown> }>;
    } | null;
  } | null;
};

try {
  const parentUrl = fixture.url('/parent');
  const opened = JSON.parse(await browser.openWithProfile(parentUrl, profileDir, {
    headless: true,
  })) as Snapshot;
  assert.equal(new URL(opened.url).pathname, '/parent');
  await browser.wait('#delayed', 2_000, 'visible');

  const longContent = JSON.parse(await browser.extract({
    selector: '#long-content',
    limit: 10_000,
  })) as Extract;
  assert.ok(longContent.textLength > 50_000);
  assert.equal(longContent.returnedTextLength, 10_000);
  assert.equal(longContent.hasMore, true);
  const continuation = JSON.parse(await browser.extract({
    selector: '#long-content',
    offset: longContent.nextOffset!,
    limit: 10_000,
  })) as Extract;
  assert.equal(continuation.text.length, 10_000);

  const formSnapshot = JSON.parse(await browser.snapshot()) as Snapshot;
  const taskName = formSnapshot.interactive.find((element) => element.placeholder === 'Task name');
  assert.ok(taskName?.ref, 'snapshot must expose an opaque ref for the form field');
  const typed = JSON.parse(await browser.type({ ref: taskName.ref }, 'Browser fixture')) as Snapshot;
  const save = typed.interactive.find((element) => element.hint.includes('#save'));
  assert.ok(save?.ref, 'snapshot must expose an opaque ref for the save button');
  const saved = JSON.parse(await browser.click({ ref: save.ref })) as Snapshot;
  assert.match(saved.text, /Saved: Browser fixture/);
  await browser.scroll({ deltaY: 800 });
  assert.match((JSON.parse(await browser.snapshot()) as Snapshot).text, /Scrolled/);

  const context = (browser as unknown as BrowserSessionInternals).impl?.context;
  assert.ok(context, 'Playwright smoke requires an active browser context');
  const unrelated = await context.newPage();
  await unrelated.goto(fixture.url('/child'));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  const stillParent = JSON.parse(await browser.snapshot()) as Snapshot;
  assert.equal(new URL(stillParent.url).pathname, '/parent');

  const child = JSON.parse(await browser.click('#open-popup')) as Snapshot;
  assert.equal(new URL(child.url).pathname, '/child');

  const returned = JSON.parse(await browser.click('#close-popup')) as Snapshot;
  assert.equal(new URL(returned.url).pathname, '/parent');
  await browser.wait('#close-popup', 2_000, 'hidden');
  console.log('[browser-smoke] popup follow and parent fallback passed');
} finally {
  await browser.close();
  await fixture.close();
  await rm(profileDir, { recursive: true, force: true });
}
