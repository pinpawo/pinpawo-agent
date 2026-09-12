import { arch, cpus, homedir, hostname, platform, release, type } from 'node:os';

export type RuntimeEnvironmentSummaryOptions = {
  sessionStartedAt?: string;
  timezone?: string;
};

function resolveTimezone(timezone?: string): string {
  if (timezone?.trim()) return timezone.trim();
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
}

export function buildRuntimeEnvironmentSummary(
  options: RuntimeEnvironmentSummaryOptions = {},
): string {
  const sessionStartedAt = options.sessionStartedAt?.trim();
  const lines = [
    '[运行环境]',
    `- 操作系统：${type()} ${release()} (${platform()} ${arch()})`,
    `- 主机名：${hostname()}`,
    `- CPU：${cpus().length} cores`,
    `- Node.js：${process.version}`,
    sessionStartedAt ? `- 会话开始时间：${sessionStartedAt}` : null,
    sessionStartedAt ? `- 时区：${resolveTimezone(options.timezone)}` : null,
    `- 用户主目录：${homedir()}`,
    process.env.SHELL ? `- Shell：${process.env.SHELL}` : null,
    '- 以上信息只描述本地运行环境，不包含密钥、Token 或完整环境变量。',
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}
