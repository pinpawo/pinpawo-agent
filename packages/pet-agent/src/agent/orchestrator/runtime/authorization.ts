import {
  mergeToolAuthorizations,
  readToolAuthorizationRecord,
  type ToolAuthorizationRecord,
} from '../review/reviewAuthorizations';

export function createToolAuthorizationRecorder(current: ToolAuthorizationRecord[]) {
  const active = mergeToolAuthorizations([], current);

  return {
    active,
    recordToolAuthorizations: (authorizations: ToolAuthorizationRecord[]) => {
      const normalized = authorizations.map(readToolAuthorizationRecord);
      if (normalized.some((authorization) => !authorization)) {
        throw new TypeError('Authorization batches must contain only valid records.');
      }
      const validAuthorizations = normalized as ToolAuthorizationRecord[];
      const merged = mergeToolAuthorizations(active, validAuthorizations);
      active.splice(0, active.length, ...merged);
    },
  };
}
