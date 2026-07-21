import React from 'react';
import { Box, Text } from 'ink';
import type { WelcomePanelModel } from '../welcomePanelModel';

export function WelcomePanel(props: {
  model: WelcomePanelModel;
}) {
  const { model } = props;
  const statusColor = model.ready ? 'green' : undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={model.ready ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Box
        flexDirection={model.stackHeader ? 'column' : 'row'}
        justifyContent={model.stackHeader ? 'flex-start' : 'space-between'}
      >
        <Text>
          <Text color="cyan" bold>{model.title}</Text>
          <Text dimColor> {model.subtitle}</Text>
        </Text>
        <Text color={statusColor} dimColor={!model.ready || model.stackHeader}>
          {model.stackHeader ? `· ${model.status}` : model.status}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{model.greeting}</Text>
        {model.summary ? <Text dimColor>{model.summary}</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {model.details.map((detail) => (
          <Text key={detail.label}>
            <Text dimColor>{detail.label.padEnd(4, ' ')}</Text>
            <Text>{detail.value}</Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="cyan">{model.ready ? '›' : '·'}</Text>
          <Text> {model.action}</Text>
        </Text>
        {model.ready ? (
          model.compact ? (
            <Box flexDirection="column">
              <Text dimColor>
                <Text color="cyan">{model.shortcuts[0]?.key}</Text>
                {' '}{model.shortcuts[0]?.label}
                {'  ·  '}
                <Text color="cyan">{model.shortcuts[1]?.key}</Text>
                {' '}{model.shortcuts[1]?.label}
              </Text>
              <Text dimColor>
                <Text color="cyan">{model.shortcuts[2]?.key}</Text>
                {' '}{model.shortcuts[2]?.label}
              </Text>
            </Box>
          ) : (
            <Text dimColor>
              {model.shortcuts.map((shortcut, index) => (
                <React.Fragment key={shortcut.key}>
                  {index > 0 ? '  ·  ' : ''}
                  <Text color="cyan">{shortcut.key}</Text>
                  {' '}{shortcut.label}
                </React.Fragment>
              ))}
            </Text>
          )
        ) : null}
      </Box>
    </Box>
  );
}
