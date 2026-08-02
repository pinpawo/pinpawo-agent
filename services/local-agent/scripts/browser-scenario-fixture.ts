import { createServer, type Server } from 'node:http';

export type BrowserScenarioFixture = {
  url(path: string): string;
  foreignUrl(path: string): string;
  close(): Promise<void>;
};

const LONG_CONTENT = 'PinPawo browser fixture content. '.repeat(2_200);

export async function startBrowserScenarioFixture(): Promise<BrowserScenarioFixture> {
  const foreignServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
      <title>Browser fixture cross-origin popup</title>
      <p>This popup closes without agent interaction.</p>
      <script>setTimeout(() => window.close(), 500)</script>`);
  });
  await listen(foreignServer);
  const foreignAddress = foreignServer.address();
  if (!foreignAddress || typeof foreignAddress === 'string') {
    await closeServer(foreignServer);
    throw new Error('Browser scenario foreign fixture did not expose a TCP port');
  }
  const foreignUrl = (path: string) => `http://127.0.0.1:${foreignAddress.port}${path}`;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/child') {
      response.end(`<!doctype html>
        <title>Browser fixture popup child</title>
        <button id="close-popup" onclick="window.close()">Close popup</button>`);
      return;
    }
    response.end(`<!doctype html>
      <title>Browser fixture parent</title>
      <style>body { min-height: 2400px; } #scroll-marker { position: fixed; top: 0; }</style>
      <h1>Browser fixture</h1>
      <label>Task name <input id="task-name" placeholder="Task name"></label>
      <button id="save" onclick="document.querySelector('#save-marker').textContent = 'Saved: ' + document.querySelector('#task-name').value">Save task</button>
      <span id="save-marker">Not saved</span>
      <a id="open-popup" href="/child" target="_blank" rel="opener">Open popup</a>
      <a id="open-cross-origin-popup" href="${foreignUrl('/child')}" target="_blank" rel="opener">Open cross-origin popup</a>
      <span id="scroll-marker">Not scrolled</span>
      <div id="delayed" hidden>Ready</div>
      <article id="long-content">${LONG_CONTENT}</article>
      <script>
        setTimeout(() => { document.querySelector('#delayed').hidden = false; }, 250);
        addEventListener('scroll', () => { document.querySelector('#scroll-marker').textContent = 'Scrolled'; }, { once: true });
      </script>`);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await Promise.all([closeServer(server), closeServer(foreignServer)]);
    throw new Error('Browser scenario fixture did not expose a TCP port');
  }
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    foreignUrl,
    close: async () => {
      await Promise.all([closeServer(server), closeServer(foreignServer)]);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
