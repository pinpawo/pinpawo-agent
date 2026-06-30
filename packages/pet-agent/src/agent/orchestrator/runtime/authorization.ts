import {
  mergeToolAuthorizations,
  type ToolAuthorizationRecord,
} from '../review/reviewAuthorizations';

export function createToolAuthorizationRecorder(current: ToolAuthorizationRecord[]) {
  const active = mergeToolAuthorizations([], current);
  const recorded: ToolAuthorizationRecord[] = [];

  return {
    active,
    recorded,
    recordToolAuthorization: (authorization: ToolAuthorizationRecord) => {
      const merged = mergeToolAuthorizations(active, [authorization]);
      if (merged.length > active.length) {
        recorded.push(authorization);
      }
      active.splice(0, active.length, ...merged);
    },
  };
}
