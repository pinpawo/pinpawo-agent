import {
  hasOnlyKeys,
  isHumanReviewOptionInput,
  isHumanReviewView,
  isJsonObject,
  readNonEmptyString,
} from '@pinpawo/agent-contracts';
import type {
  ReviewEffect,
  ReviewOption,
  ReviewOptionDecision,
  ReviewSpec,
} from './reviewSpec';

function isReviewOptionDecisionValue(value: unknown): value is ReviewOptionDecision {
  if (!isJsonObject(value)) return false;
  if (value.type === 'approve') {
    return hasOnlyKeys(value, ['type']);
  }
  if (value.type === 'reject') {
    return hasOnlyKeys(value, ['type', 'message'])
      && (value.message === undefined || typeof value.message === 'string');
  }
  if (value.type === 'respond') {
    return hasOnlyKeys(value, ['type', 'messageInputKey'])
      && value.messageInputKey === 'message';
  }
  return false;
}

function isReviewEffectValue(value: unknown): value is ReviewEffect {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['type', 'scope'])) return false;
  return value.type === 'graph.authorize_tool_action'
    && value.scope === 'thread';
}

function isReviewOptionValue(value: unknown): value is ReviewOption {
  if (
    !isJsonObject(value)
    || !hasOnlyKeys(value, ['id', 'label', 'description', 'variant', 'input', 'decision', 'effects'])
  ) {
    return false;
  }
  return Boolean(readNonEmptyString(value.id))
    && typeof value.label === 'string'
    && (value.description === undefined || typeof value.description === 'string')
    && (
      value.variant === undefined
      || value.variant === 'primary'
      || value.variant === 'normal'
      || value.variant === 'danger'
    )
    && (value.input === undefined || isHumanReviewOptionInput(value.input))
    && isReviewOptionDecisionValue(value.decision)
    && (value.effects === undefined
      || (Array.isArray(value.effects) && value.effects.every(isReviewEffectValue)));
}

export function isReviewSpecValue(value: unknown): value is ReviewSpec {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['id', 'schemaVersion', 'view', 'options'])) {
    return false;
  }
  return Boolean(readNonEmptyString(value.id))
    && typeof value.schemaVersion === 'number'
    && Number.isFinite(value.schemaVersion)
    && isHumanReviewView(value.view)
    && Array.isArray(value.options)
    && value.options.length > 0
    && value.options.every(isReviewOptionValue);
}
