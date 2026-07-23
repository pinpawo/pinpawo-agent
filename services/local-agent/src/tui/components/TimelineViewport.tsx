import React, { useEffect, useRef } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';

export function TimelineViewport(props: {
  children: React.ReactNode;
  scrollOffset: number;
  onMetricsChange: (metrics: {
    contentHeight: number;
    viewportHeight: number;
  }) => void;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);

  useEffect(() => {
    if (!viewportRef.current || !contentRef.current) return;
    props.onMetricsChange({
      contentHeight: measureElement(contentRef.current).height,
      viewportHeight: measureElement(viewportRef.current).height,
    });
  });

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflowY="hidden"
      justifyContent="flex-end"
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        marginBottom={-props.scrollOffset}
      >
        <Box ref={contentRef} flexDirection="column">
          {props.children}
        </Box>
      </Box>
    </Box>
  );
}
