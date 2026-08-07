import { browserIntegration } from '../browserIntegration';

export async function runDetect() {
  const browser = await browserIntegration.detectEnvironment().catch(() => ({
    configured: 'auto',
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromeAvailable: false,
    playwrightCorePath: null,
  }));

  process.stdout.write(JSON.stringify({ browser }) + '\n');
}
