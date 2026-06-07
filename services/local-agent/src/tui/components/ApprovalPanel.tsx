import { Box, Text } from 'ink';
import { shorten } from '../render/eventText';
import { TUI_TEXT } from '../render/text';
import { wrapLine } from '../render/terminalText';
import type { ApprovalOption, PendingApproval } from '../types';

export function buildApprovalOptions(approval: PendingApproval): ApprovalOption[] {
  const actionRequests = Array.isArray(approval.payload.actionRequests)
    ? approval.payload.actionRequests.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    )
    : [];
  const reviewConfigs = Array.isArray(approval.payload.reviewConfigs)
    ? approval.payload.reviewConfigs.filter((item): item is Record<string, unknown> =>
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
    const options: ApprovalOption[] = [];
    if (allowedDecisions.includes('approve')) {
      options.push({
        label: actionName === 'continue_execution_window'
          ? TUI_TEXT.approvalContinue
          : TUI_TEXT.approvalApproveExecution,
        message: actionName === 'continue_execution_window'
          ? TUI_TEXT.approvalContinue
          : TUI_TEXT.approvalApproveExecution,
        resume: { decisions: [{ type: 'approve' }] },
      });
    }
    if ((actionName === 'shell' || actionName === 'run_shell') && command) {
      options.push({
        label: TUI_TEXT.approvalAllowSession(shorten(command, 40)),
        message: TUI_TEXT.approvalAllowSession(shorten(command, 40)),
        resume: { decisions: [{ type: 'approve' }] },
        extras: { authorizeShellPattern: { pattern: command } },
      });
    }
    if (allowedDecisions.includes('reject')) {
      options.push({
        label: actionName === 'continue_execution_window'
          ? TUI_TEXT.approvalStopHere
          : TUI_TEXT.approvalReject,
        message: actionName === 'continue_execution_window'
          ? TUI_TEXT.approvalStopHere
          : TUI_TEXT.approvalReject,
        resume: { decisions: [{ type: 'reject' }] },
      });
    }
    if (options.length > 0) {
      return options;
    }
  }
  return [
    {
      label: TUI_TEXT.approvalApprove,
      message: TUI_TEXT.approvalApprove,
      resume: { decisions: [{ type: 'approve' }] },
    },
    {
      label: TUI_TEXT.approvalReject,
      message: TUI_TEXT.approvalReject,
      resume: { decisions: [{ type: 'reject' }] },
    },
  ];
}

export function ApprovalPanel(props: {
  approval: PendingApproval;
  width: number;
  options: ApprovalOption[];
  selectedIndex: number;
}) {
  const promptLines = wrapLine(props.approval.prompt, props.width - 4);
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
        {TUI_TEXT.approvalHeading(props.approval.petId)}
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
      <Text dimColor>{TUI_TEXT.approvalHelp}</Text>
    </Box>
  );
}
