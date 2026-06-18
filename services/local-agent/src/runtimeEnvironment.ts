import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { arch, cpus, homedir, hostname, platform, release, type } from 'node:os';
import { config } from './config';

function pathStatus(path: string): string {
  if (!path) return 'not configured';
  try {
    const stat = statSync(path);
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    let writable = 'not writable';
    try {
      accessSync(path, constants.W_OK);
      writable = 'writable';
    } catch {
      // Keep the status compact for the prompt.
    }
    return existsSync(path) ? `${kind}, ${writable}` : 'missing';
  } catch {
    return 'missing';
  }
}

export function buildRuntimeEnvironmentSummary(workdir = config.workdir): string {
  const lines = [
    '[运行环境]',
    `- 操作系统：${type()} ${release()} (${platform()} ${arch()})`,
    `- 主机名：${hostname()}`,
    `- CPU：${cpus().length} cores`,
    `- Node.js：${process.version}`,
    `- Agent 工作目录：${workdir} (${pathStatus(workdir)})`,
    `- 进程 cwd：${process.cwd()} (${pathStatus(process.cwd())})`,
    `- 用户主目录：${homedir()}`,
    process.env.SHELL ? `- Shell：${process.env.SHELL}` : null,
    `- Browser backend：${config.browserBackend}`,
    '- 相对路径默认相对于 Agent 工作目录。',
    '- 以上信息只描述本地运行环境，不包含密钥、Token 或完整环境变量。',
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}
