import type { AgentLocalAttachment } from '@pinpawo/agent-session';
import type { PasteEvent } from '@opentui/core';
import {
  mergeAttachments,
} from './attachmentModel';
import {
  ingestLocalPathPaste,
  type LocalPathIngestionOptions,
} from './localPathIngestion';

export type AttachmentPasteResult =
  | {
      handled: false;
      attachments: AgentLocalAttachment[];
      pendingNotice: string | null;
    }
  | {
      handled: true;
      attachments: AgentLocalAttachment[];
      notice: string;
    };

export function applyAttachmentPaste(
  current: readonly AgentLocalAttachment[],
  input: string,
  options: Pick<LocalPathIngestionOptions, 'idFactory'> = {},
): AttachmentPasteResult {
  const ingestion = ingestLocalPathPaste(input, {
    existingPaths: new Set(current.map((attachment) => attachment.path)),
    ...options,
  });
  if (ingestion.kind === 'text') {
    return {
      handled: false,
      attachments: [...current],
      pendingNotice: ingestion.pathLike
        ? `${ingestion.issue}; inserted as text`
        : null,
    };
  }

  const attachments = mergeAttachments(current, ingestion.attachments);
  const addedCount = attachments.length - current.length;
  return {
    handled: true,
    attachments,
    notice: formatAttachmentPasteNotice(
      addedCount,
      ingestion.duplicateCount,
      ingestion.attachments.length - addedCount,
    ),
  };
}

export function handleAttachmentPasteEvent(
  current: readonly AgentLocalAttachment[],
  event: PasteEvent,
  options: Pick<LocalPathIngestionOptions, 'idFactory'> = {},
) {
  const result = applyAttachmentPaste(
    current,
    new TextDecoder().decode(event.bytes),
    options,
  );
  if (result.handled) {
    event.preventDefault();
  }
  return result;
}

export function formatAttachmentPasteNotice(
  added: number,
  duplicates: number,
  overLimit: number,
) {
  if (added === 0 && overLimit > 0) {
    return 'attachment limit reached';
  }
  if (added === 0 && duplicates > 0) {
    return 'attachment already added';
  }
  return [
    `attached ${added} local path${added === 1 ? '' : 's'}`,
    ...(duplicates > 0
      ? [`skipped ${duplicates} duplicate${duplicates === 1 ? '' : 's'}`]
      : []),
    ...(overLimit > 0 ? [`skipped ${overLimit} over limit`] : []),
  ].join(' · ');
}
