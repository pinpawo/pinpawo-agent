import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { Box, renderToString, Text } from 'ink';
import { TimelineViewport } from './TimelineViewport';

test('TimelineViewport follows the tail and can reveal earlier terminal rows', () => {
  const rows = Array.from({ length: 10 }, (_, index) => (
    <Box key={index} flexShrink={0}>
      <Text>{`line${index + 1}`}</Text>
    </Box>
  ));
  const renderViewport = (scrollOffset: number) => renderToString(
    <Box height={5} flexDirection="column">
      <TimelineViewport scrollOffset={scrollOffset} onMetricsChange={() => undefined}>
        {rows}
      </TimelineViewport>
    </Box>,
    { columns: 20 },
  );

  assert.equal(renderViewport(0), 'line6\nline7\nline8\nline9\nline10');
  assert.equal(renderViewport(2), 'line4\nline5\nline6\nline7\nline8');
});
