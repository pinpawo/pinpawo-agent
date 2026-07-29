import React from 'react';
import { Box, Text } from 'ink';
import type { AgentModelProfileSummary } from '@pinpawo/agent-session';
import { TUI_TEXT } from '../render/text';
import { canSelectModelProfile } from '../modelProfilePicker';

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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
      <Text color="magenta" bold>{TUI_TEXT.modelProfilePickerTitle}</Text>
      <Text dimColor>
        {TUI_TEXT.modelProfileRequiredInput(props.requiredInputModalities)}
      </Text>
      {props.loading ? (
        <Text dimColor>{TUI_TEXT.modelProfileLoading}</Text>
      ) : props.profiles.length === 0 ? (
        <Text dimColor>{TUI_TEXT.modelProfileEmpty}</Text>
      ) : (
        props.profiles.map((profile, index) => {
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
          ].filter(Boolean).join(' · ');
          return (
            <Box key={profile.id} flexDirection="column">
              <Text
                color={selected ? 'magenta' : current ? 'green' : selectable ? undefined : 'gray'}
                bold={selected}
                dimColor={!selectable && !selected}
              >
                {selected ? '›' : ' '} {truncate(profile.label, Math.max(20, props.width - 24))}
                {badges ? ` ${badges}` : ''}
              </Text>
              <Text dimColor>  {profile.id}{meta ? ` · ${meta}` : ''}</Text>
              {profile.issues[0] ? (
                <Text color={selected ? 'yellow' : undefined} dimColor={!selected}>
                  {'  '}{truncate(profile.issues[0], Math.max(20, props.width - 5))}
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

function truncate(value: string, max: number) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
