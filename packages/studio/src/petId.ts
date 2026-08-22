const WINDOWS_RESERVED_PATH_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_INVALID_PATH_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/u;

/**
 * Pet ids are persisted as directory names, so they must be portable path
 * segments rather than merely safe on the current Host platform.
 */
export function isSafePetPathSegment(petId: string): boolean {
  return petId.length > 0
    && petId !== '.'
    && petId !== '..'
    && !WINDOWS_INVALID_PATH_CHARACTER.test(petId)
    && !/[. ]$/u.test(petId)
    && !WINDOWS_RESERVED_PATH_NAME.test(petId);
}
