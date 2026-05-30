import { Box, Text } from 'ink';
import { shorten } from '../render/eventText';
import { wrapLine } from '../render/terminalText';
import type { InterruptOption, PendingInterrupt } from '../types';

export function buildInterruptSelectOptions(interrupt: PendingInterrupt): InterruptOption[] {
  const actionRequests = Array.isArray(interrupt.payload.actionRequests)
    ? interrupt.payload.actionRequests.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    )
    : [];
  const reviewConfigs = Array.isArray(interrupt.payload.reviewConfigs)
    ? interrupt.payload.reviewConfigs.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    )
    : [];
  const firstAction = actionRequests[0];
  const firstConfig = reviewConfigs[0];
  const actionName = firstAction && typeof firstAction.name === 'string'
    ? firstAction.name
    : firstAction && typeof firstAction.action === 'string'
      ? firstAction.action
      : '';
  const args = firstAction?.args && typeof firstAction.args === 'object'
    ? firstAction.args as Record<string, unknown>
    : {};
  const command = typeof args.command === 'string' ? args.command : '';
  const allowedDecisions = Array.isArray(firstConfig?.allowedDecisions)
    ? firstConfig.allowedDecisions.filter((item): item is string => typeof item === 'string')
    : ['approve', 'reject', 'respond'];

  if (actionRequests.length > 0) {
    const options: InterruptOption[] = [];
    if (allowedDecisions.includes('approve')) {
      options.push({
        label: actionName === 'continue_execution_window' ? '继续' : '批准执行',
        message: actionName === 'continue_execution_window' ? '继续' : '批准执行',
        resume: { decisions: [{ type: 'approve' }] },
      });
    }
    if ((actionName === 'shell' || actionName === 'run_shell') && command) {
      options.push({
        label: `本次会话授权：${shorten(command, 40)}`,
        message: '/allow',
      });
    }
    if (allowedDecisions.includes('reject')) {
      options.push({
        label: actionName === 'continue_execution_window' ? '停在这里' : '拒绝',
        message: actionName === 'continue_execution_window' ? '停在这里' : '拒绝',
        resume: { decisions: [{ type: 'reject' }] },
      });
    }
    if (options.length > 0) {
      return options;
    }
  }
  return [
    { label: '批准', message: '批准', resume: { decisions: [{ type: 'approve' }] } },
    { label: '拒绝', message: '拒绝', resume: { decisions: [{ type: 'reject' }] } },
  ];
}

export function InterruptSelector(props: {
  interrupt: PendingInterrupt;
  width: number;
  options: InterruptOption[];
  selectedIndex: number;
}) {
  const promptLines = wrapLine(props.interrupt.prompt, props.width - 4);
  const selectedIndex = Math.max(0, Math.min(props.options.length - 1, props.selectedIndex));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      width={props.width}
    >
      <Text color="yellow">
        {props.interrupt.petId ? `[${props.interrupt.petId} 想问你]` : '需要确认'}
      </Text>
      {promptLines.map((line, i) => (
        <Text key={`p-${i}`}>{line}</Text>
      ))}
      <Text>{' '}</Text>
      {props.options.map((opt, i) => (
        <Text key={`o-${i}`} color={i === selectedIndex ? 'cyan' : undefined} bold={i === selectedIndex}>
          {i === selectedIndex ? '› ' : '  '}{opt.label}
        </Text>
      ))}
      <Text>{' '}</Text>
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 自由输入</Text>
    </Box>
  );
}
