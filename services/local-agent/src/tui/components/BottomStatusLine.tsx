import { Text } from 'ink';
import type { BuiltinGlobalReviewPolicyMode } from '@pinpawo/pet-agent';
import type { SessionModel } from '../state/tuiState';
import { formatGlobalReviewPolicyMode } from '../globalReviewPolicyPicker';

const LOCALE_FORMATTER = new Intl.NumberFormat('zh-CN');

export function BottomStatusLine(props: {
  status: string;
  session: SessionModel | null;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  width: number;
}) {
  const sessionMode = props.session?.kind === 'studio' ? 'Studio' : 'Chat';
  const runtime = props.session?.runtime;
  const pieces = [
    props.status,
    sessionMode,
    `授权:${formatGlobalReviewPolicyMode(props.globalReviewPolicyMode)}`,
    `模型:${fallback(runtime?.model)}`,
    `上下文:${formatContext(props.session)}`,
    `目录:${fallback(runtime?.cwd)}`,
  ];

  return (
    <Text dimColor>{truncate(pieces.join(' · '), props.width)}</Text>
  );
}

function fallback(value: string | undefined) {
  const text = value?.trim();
  return text ? text : '未提供';
}

function formatContext(session: SessionModel | null) {
  const usage = session?.tokenUsage;
  const contextWindow = usage?.contextWindow ?? session?.runtime.contextWindow;
  if (usage && contextWindow) {
    return `${formatCount(usage.totalTokens)}/${formatCount(contextWindow)} (${formatRatio(usage.totalTokens, contextWindow)})`;
  }
  if (usage) {
    return `${formatCount(usage.totalTokens)} tokens`;
  }
  if (contextWindow) {
    return formatCount(contextWindow);
  }
  return '未提供';
}

function formatCount(value: number) {
  return LOCALE_FORMATTER.format(Math.max(0, Math.round(value)));
}

function formatRatio(total: number, contextWindow: number) {
  if (!contextWindow) return '0.0%';
  return `${((total / contextWindow) * 100).toFixed(1)}%`;
}

function truncate(value: string, width: number) {
  const max = Math.max(20, width);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
