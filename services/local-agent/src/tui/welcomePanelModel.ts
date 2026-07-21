import { truncateLine } from './render/terminalText';
import { TUI_TEXT } from './render/text';
import type { SessionModel } from './state/tuiState';

export type WelcomePanelDetail = {
  label: string;
  value: string;
};

export type WelcomePanelShortcut = {
  key: string;
  label: string;
};

export type WelcomePanelModel = {
  compact: boolean;
  stackHeader: boolean;
  title: string;
  subtitle: string;
  greeting: string;
  summary: string | null;
  status: string;
  ready: boolean;
  action: string;
  details: WelcomePanelDetail[];
  shortcuts: WelcomePanelShortcut[];
};

export function buildWelcomePanelModel(input: {
  session: SessionModel | null;
  width: number;
  ready: boolean;
  connectionStatus: string;
}): WelcomePanelModel {
  const compact = input.width < 56;
  const stackHeader = input.width < 40;
  const petName = fallback(input.session?.actor.label, TUI_TEXT.defaultPetName);
  const runtime = input.session?.runtime;
  const valueWidth = Math.max(12, input.width - (compact ? 10 : 14));
  const summary = normalizeSummary(input.session?.actor.summary, valueWidth);
  const directory = runtime?.workspaceName?.trim()
    ? `${runtime.workspaceName.trim()} · ${fallback(runtime.cwd, TUI_TEXT.valueLoading)}`
    : fallback(runtime?.cwd, TUI_TEXT.valueLoading);

  return {
    compact,
    stackHeader,
    title: TUI_TEXT.welcomeTitle,
    subtitle: TUI_TEXT.welcomeSubtitle,
    greeting: compact
      ? TUI_TEXT.welcomeCompactGreeting(petName)
      : TUI_TEXT.welcomeGreeting(petName),
    summary,
    status: truncateLine(input.connectionStatus, compact ? 14 : 22),
    ready: input.ready,
    action: input.ready
      ? compact
        ? TUI_TEXT.welcomeCompactReadyAction
        : TUI_TEXT.welcomeReadyAction
      : TUI_TEXT.welcomePreparingAction,
    details: [
      {
        label: TUI_TEXT.welcomeModelLabel,
        value: truncateLine(fallback(runtime?.model, TUI_TEXT.valueLoading), valueWidth),
      },
      {
        label: TUI_TEXT.welcomeDirectoryLabel,
        value: truncateLine(directory, valueWidth),
      },
    ],
    shortcuts: [
      { key: '@', label: TUI_TEXT.welcomeFileShortcut },
      { key: '/', label: TUI_TEXT.welcomeCommandShortcut },
      { key: '/resume', label: TUI_TEXT.welcomeResumeShortcut },
    ],
  };
}

function normalizeSummary(value: string | undefined, width: number) {
  const summary = value?.replace(/\s+/g, ' ').trim();
  if (!summary || summary === TUI_TEXT.defaultPetSummary) return null;
  return truncateLine(summary, width);
}

function fallback(value: string | undefined, fallbackValue: string) {
  const text = value?.trim();
  return text || fallbackValue;
}
