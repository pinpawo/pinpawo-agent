import {
  mergeToolAuthorizations,
  readToolAuthorizationRecord,
  toolAuthorizationRecordKey,
  type ToolAuthorizationRecord,
} from '../review/reviewAuthorizations';

export function createToolAuthorizationRecorder(current: ToolAuthorizationRecord[]) {
  const active = mergeToolAuthorizations([], current);
  const recorded: ToolAuthorizationRecord[] = [];

  return {
    active,
    recorded,
    recordToolAuthorizations: (authorizations: ToolAuthorizationRecord[]) => {
      const normalized = authorizations.map(readToolAuthorizationRecord);
      if (normalized.some((authorization) => !authorization)) {
        throw new TypeError('Authorization batches must contain only valid records.');
      }
      const validAuthorizations = normalized as ToolAuthorizationRecord[];
      const previousByKey = new Map(
        active.map((authorization) => [
          toolAuthorizationRecordKey(authorization),
          authorization,
        ]),
      );
      const merged = mergeToolAuthorizations(active, validAuthorizations);
      const changed = merged.filter((authorization) => {
        const previous = previousByKey.get(toolAuthorizationRecordKey(authorization));
        return !previous || previous.source !== authorization.source;
      });
      const nextRecorded = mergeToolAuthorizations(recorded, changed);
      recorded.splice(0, recorded.length, ...nextRecorded);
      active.splice(0, active.length, ...merged);
    },
  };
}
