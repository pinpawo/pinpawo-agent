import React from 'react';
import { Box, Text } from 'ink';
import type { AgentModelProfileSummary } from '@pinpawo/agent-session';
import { TUI_TEXT } from '../render/text';
import { truncateLine } from '../render/terminalText';
import {
  canSelectModelProfile,
  windowModelProfilePickerProfiles,
} from '../modelProfilePicker';

export function ModelProfilePicker(props: {
  profiles: AgentModelProfileSummary[];
  selectedProfileId: string;
  defaultProfileId: string;
  requiredInputModalities: string[];
  selectedIndex: number;
  loading: boolean;
  applying: boolean;
  width: number;
}) {
  const selectedIndex = Math.max(
    0,
    Math.min(Math.max(0, props.profiles.length - 1), props.selectedIndex),
  );
  const innerWidth = Math.max(1, props.width - 4);
  const visibleProfiles = windowModelProfilePickerProfiles(
    props.profiles,
    selectedIndex,
  );
  const position = props.profiles.length > 0
    ? ` · ${selectedIndex + 1}/${props.profiles.length}`
    : '';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text color="magenta" bold>{TUI_TEXT.modelProfilePickerTitle}</Text>
      <Text dimColor>
        {truncateLine(
          `${TUI_TEXT.modelProfileRequiredInput(props.requiredInputModalities)}${position}`,
          innerWidth,
        )}
      </Text>
      {props.loading ? (
        <Text dimColor>{TUI_TEXT.modelProfileLoading}</Text>
      ) : props.profiles.length === 0 ? (
        <Text dimColor>{TUI_TEXT.modelProfileEmpty}</Text>
      ) : (
        visibleProfiles.profiles.map((profile, visibleIndex) => {
          const index = visibleProfiles.start + visibleIndex;
          const selected = index === selectedIndex;
          const current = profile.id === props.selectedProfileId;
          const selectable = canSelectModelProfile(profile);
          const badges = [
            current ? TUI_TEXT.modelProfileCurrentBadge : null,
            profile.id === props.defaultProfileId
              ? TUI_TEXT.modelProfileDefaultBadge
              : null,
            profile.inputModalities.includes('image')
              ? TUI_TEXT.modelProfileImageBadge
              : null,
            !profile.available
              ? TUI_TEXT.modelProfileUnavailableBadge
              : !profile.compatible
                ? TUI_TEXT.modelProfileIncompatibleBadge
                : null,
          ].filter(Boolean).join(' ');
          const meta = [
            profile.provider,
            profile.model,
            profile.endpointHost,
            profile.contextWindowTokens
              ? `${profile.contextWindowTokens.toLocaleString('en-US')} ctx`
              : null,
          ].filter(Boolean).map((value) => singleLine(value!)).join(' · ');
          const prefix = selected ? '› ' : '  ';
          const labelLine = `${prefix}${singleLine(profile.label)}${badges ? ` ${badges}` : ''}`;
          const metadataLine = `  ${singleLine(profile.id)}${meta ? ` · ${meta}` : ''}`;
          return (
            <Box key={profile.id} flexDirection="column">
              <Text
                color={selected ? 'magenta' : current ? 'green' : selectable ? undefined : 'gray'}
                bold={selected}
                dimColor={!selectable && !selected}
              >
                {truncateLine(labelLine, innerWidth)}
              </Text>
              <Text dimColor>{truncateLine(metadataLine, innerWidth)}</Text>
              {profile.issues[0] ? (
                <Text color={selected ? 'yellow' : undefined} dimColor={!selected}>
                  {truncateLine(`  ${singleLine(profile.issues[0])}`, innerWidth)}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
      <Text dimColor>
        {props.applying
          ? TUI_TEXT.modelProfileApplying
          : TUI_TEXT.modelProfilePickerHelp}
      </Text>
    </Box>
  );
}

function singleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}
