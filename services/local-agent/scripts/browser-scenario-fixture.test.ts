import assert from 'node:assert/strict';
import test from 'node:test';
import { startBrowserScenarioFixture } from './browser-scenario-fixture';

test('browser scenario fixture provides deterministic dynamic, form, popup and long-content cases', async () => {
  const fixture = await startBrowserScenarioFixture();
  try {
    const parent = await fetch(fixture.url('/parent'));
    const html = await parent.text();
    assert.match(html, /id="task-name"/);
    assert.match(html, /id="open-popup"/);
    assert.match(html, /id="open-cross-origin-popup"/);
    assert.match(html, /id="same-origin-frame"/);
    assert.match(html, /id="cross-origin-frame"/);
    assert.match(html, /open-shadow-host/);
    assert.match(html, /closed-shadow-host/);
    assert.match(html, /shadow-marker/);
    assert.match(html, /id="long-content"/);
    assert.match(html, /id="never-visible"/);
    assert.ok(html.length > 50_000);

    const child = await fetch(fixture.url('/child'));
    assert.match(await child.text(), /id="close-popup"/);

    const foreignChild = await fetch(fixture.foreignUrl('/child'));
    assert.match(await foreignChild.text(), /cross-origin popup/);

    const sameOriginFrame = await fetch(fixture.url('/iframe-child'));
    assert.match(await sameOriginFrame.text(), /Same-origin iframe fixture content/);
    const crossOriginFrame = await fetch(fixture.foreignUrl('/iframe-child'));
    assert.match(await crossOriginFrame.text(), /Cross-origin iframe fixture content/);
  } finally {
    await fixture.close();
  }
});
