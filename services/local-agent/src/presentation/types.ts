export type PresentationParam = string | number | boolean | null | undefined;

export type PresentationMessage = {
  key: string;
  params?: Record<string, PresentationParam>;
};

export type ToolPresentation = {
  label: PresentationMessage;
  detail: PresentationMessage | null;
};

export type ToolPresentationInput = {
  toolName: string;
  input: string;
  output: string;
  error: string;
};

export function message(key: string, params?: Record<string, PresentationParam>): PresentationMessage {
  return params ? { key, params } : { key };
}

export function rawText(text: string): PresentationMessage {
  return message('raw', { text });
}
