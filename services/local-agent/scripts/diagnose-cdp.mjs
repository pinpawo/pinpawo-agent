import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.argv.includes('--worker')) {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-cdp-diagnostic-'));
  const logPath = join(directory, 'diagnostic.log');
  const log = await open(logPath, 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    detached: true, cwd: directory, stdio: ['ignore', log.fd, log.fd], env: process.env,
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  await log.close();
  process.stdout.write(await readFile(logPath, 'utf8'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  process.exitCode = result ?? 1;
} else {
  const executable = [process.env.PROGRAMFILES ?? 'C:\\Program Files', process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)']
    .map((directory) => join(directory, 'Google/Chrome/Application/chrome.exe')).find(existsSync);
  if (!executable) throw new Error('Chrome is not installed.');
  for (const [name, extraArgs] of [
    ['current', []],
    ['unoccluded', ['--disable-backgrounding-occluded-windows']],
    ['software', ['--disable-gpu']],
    ['unsandboxed', ['--no-sandbox']],
  ]) {
    const profile = await mkdtemp(join(tmpdir(), 'ppr-cdp-probe-'));
    const args = [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      '--enable-features=CDPScreenshotNewSurface', '--headless=new', ...extraArgs, 'about:blank',
    ];
    let stderr = '';
    const child = spawn(executable, args, { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
    let browser;
    try {
      const endpoint = await new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          const endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
          if (endpoint) { clearInterval(interval); clearTimeout(timeout); resolve(endpoint); }
        }, 25);
        const timeout = setTimeout(() => { clearInterval(interval); reject(new Error('CDP endpoint timeout')); }, 15_000);
        child.once('error', (error) => { clearInterval(interval); clearTimeout(timeout); reject(error); });
      });
      browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
      console.log(name + ': Chrome ' + browser.version());
      const context = browser.contexts()[0];
      const a = await context.newPage();
      await a.goto('data:text/html,<title>A</title><h1>Background page A</h1>');
      const screenshot = async (pageName, page) => {
        console.log(name + '/' + pageName + ' layout: ' + JSON.stringify(await page.evaluate(() => ({
          width: innerWidth, height: innerHeight, outerWidth, outerHeight, visibility: document.visibilityState,
        }))));
        const started = Date.now();
        try {
          const data = await page.screenshot({ type: 'jpeg', timeout: 15_000 });
          console.log(name + '/' + pageName + ': ' + data.length + ' bytes in ' + (Date.now() - started) + 'ms');
        } catch (error) {
          console.log(name + '/' + pageName + ': ' + String(error).slice(0, 2000));
        }
      };
      await screenshot('A-only', a);
      const b = await context.newPage();
      await b.goto('data:text/html,<title>B</title><h1>Foreground page B</h1>');
      await screenshot('A-background', a);
      await screenshot('B', b);
      await a.bringToFront();
      await screenshot('A-foreground', a);
    } catch (error) {
      console.log(name + ': ' + String(error).slice(0, 2000));
    } finally {
      console.log(name + ' Chrome stderr: ' + stderr.slice(-4000));
      // This process and profile belong exclusively to this diagnostic.
      if (browser?.isConnected()) {
        await browser.newBrowserCDPSession().then((session) => session.send('Browser.close')).catch(() => {});
      }
      await browser?.close().catch(() => {});
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}
