import { detectBrowserEnvironment } from '../plugins/browserSession';

export async function runDetect() {
  const browser = await detectBrowserEnvironment().catch(() => ({
    configured: 'auto',
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromeAvailable: false,
    playwrightCorePath: null,
    agentBrowserPath: null,
  }));

  process.stdout.write(JSON.stringify({ browser }) + '\n');
}
