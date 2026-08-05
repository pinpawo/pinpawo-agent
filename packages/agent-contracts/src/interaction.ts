import type { JsonObject } from './json';
import {
  hasOnlyKeys,
  isJsonObject,
  isJsonValue,
  readNonEmptyString,
} from './json';

export type HumanReviewView =
  | { kind: 'plain'; title?: string; body: string }
  | { kind: 'markdown'; title?: string; body: string }
  | { kind: 'diff'; title?: string; patch: string; target?: string; summary?: string };

export type HumanReviewOptionInput = {
  kind: 'text';
  key: 'message';
  label?: string;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
};

/** A user-visible option. Runtime decisions and effects are deliberately absent. */
export type HumanReviewOption = {
  id: string;
  label: string;
  description?: string;
  variant?: 'primary' | 'normal' | 'danger';
  input?: HumanReviewOptionInput;
  /** True when the UI may collect another response in the same interaction batch. */
  continuesInteraction?: boolean;
};

/** A transport-neutral request for a human decision. */
export type HumanReviewRequest = {
  interactionId: string;
  schemaVersion: number;
  view: HumanReviewView;
  options: HumanReviewOption[];
};

/** The human's selection. Effects remain authoritative inside the runtime. */
export type HumanReviewResponse = {
  interactionId: string;
  selectedOptionId: string;
  input?: JsonObject;
};

export type HumanReviewBatchResponse = {
  responses: HumanReviewResponse[];
};

function isHumanReviewView(value: unknown): value is HumanReviewView {
  if (!isJsonObject(value)) return false;
  const titleIsValid = value.title === undefined || typeof value.title === 'string';
  if (value.kind === 'plain' || value.kind === 'markdown') {
    return hasOnlyKeys(value, ['kind', 'title', 'body'])
      && titleIsValid
      && typeof value.body === 'string';
  }
  if (value.kind === 'diff') {
    return hasOnlyKeys(value, ['kind', 'title', 'patch', 'target', 'summary'])
      && titleIsValid
      && typeof value.patch === 'string'
      && (value.target === undefined || typeof value.target === 'string')
      && (value.summary === undefined || typeof value.summary === 'string');
  }
  return false;
}

function isHumanReviewOptionInput(value: unknown): value is HumanReviewOptionInput {
  return isJsonObject(value)
    && hasOnlyKeys(value, ['kind', 'key', 'label', 'placeholder', 'required', 'multiline'])
    && value.kind === 'text'
    && value.key === 'message'
    && (value.label === undefined || typeof value.label === 'string')
    && (value.placeholder === undefined || typeof value.placeholder === 'string')
    && (value.required === undefined || typeof value.required === 'boolean')
    && (value.multiline === undefined || typeof value.multiline === 'boolean');
}

function isHumanReviewOption(value: unknown): value is HumanReviewOption {
  return isJsonObject(value)
    && hasOnlyKeys(value, ['id', 'label', 'description', 'variant', 'input', 'continuesInteraction'])
    && readNonEmptyString(value.id) !== null
    && typeof value.label === 'string'
    && (value.description === undefined || typeof value.description === 'string')
    && (
      value.variant === undefined
      || value.variant === 'primary'
      || value.variant === 'normal'
      || value.variant === 'danger'
    )
    && (value.input === undefined || isHumanReviewOptionInput(value.input))
    && (value.continuesInteraction === undefined || typeof value.continuesInteraction === 'boolean');
}

export function parseHumanReviewRequest(value: unknown): HumanReviewRequest | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['interactionId', 'schemaVersion', 'view', 'options'])) {
    return null;
  }
  const interactionId = readNonEmptyString(value.interactionId);
  if (
    interactionId === null
    || typeof value.schemaVersion !== 'number'
    || !Number.isFinite(value.schemaVersion)
    || !isHumanReviewView(value.view)
    || !Array.isArray(value.options)
    || value.options.length === 0
    || !value.options.every(isHumanReviewOption)
  ) {
    return null;
  }
  return {
    interactionId,
    schemaVersion: value.schemaVersion,
    view: value.view,
    options: value.options,
  };
}

export function isHumanReviewRequest(value: unknown): value is HumanReviewRequest {
  return parseHumanReviewRequest(value) !== null;
}

export function parseHumanReviewResponse(value: unknown): HumanReviewResponse | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['interactionId', 'selectedOptionId', 'input'])) {
    return null;
  }
  const interactionId = readNonEmptyString(value.interactionId);
  const selectedOptionId = readNonEmptyString(value.selectedOptionId);
  if (
    interactionId === null
    || selectedOptionId === null
    || (value.input !== undefined && (!isJsonObject(value.input) || !isJsonValue(value.input)))
  ) {
    return null;
  }
  return {
    interactionId,
    selectedOptionId,
    ...(value.input !== undefined ? { input: value.input as JsonObject } : {}),
  };
}

export function isHumanReviewResponse(value: unknown): value is HumanReviewResponse {
  return parseHumanReviewResponse(value) !== null;
}

export function parseHumanReviewBatchResponse(value: unknown): HumanReviewBatchResponse | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['responses']) || !Array.isArray(value.responses)) {
    return null;
  }
  const responses = value.responses.map(parseHumanReviewResponse);
  return responses.length > 0 && responses.every((response) => response !== null)
    ? { responses: responses as HumanReviewResponse[] }
    : null;
}
