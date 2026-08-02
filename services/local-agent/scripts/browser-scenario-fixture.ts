import { createServer, type Server } from 'node:http';

export type BrowserScenarioFixture = {
  url(path: string): string;
  close(): Promise<void>;
};

const LONG_CONTENT = 'PinPawo browser fixture content. '.repeat(2_200);

export async function startBrowserScenarioFixture(): Promise<BrowserScenarioFixture> {
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
      <span id="scroll-marker">Not scrolled</span>
      <div id="delayed" hidden>Ready</div>
      <article id="long-content">${LONG_CONTENT}</article>
      <script>
        setTimeout(() => { document.querySelector('#delayed').hidden = false; }, 250);
        addEventListener('scroll', () => { document.querySelector('#scroll-marker').textContent = 'Scrolled'; }, { once: true });
      </script>`);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Browser scenario fixture did not expose a TCP port');
  }
  return {
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}
