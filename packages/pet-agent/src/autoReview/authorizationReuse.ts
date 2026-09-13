import type { ToolAuthorizationMatcher } from './authorizationMatchers';
import type { ToolAuthorizationPolicy } from './policy';

/** Current-call approval may only create/reuse a grant under an explicit exact policy. */
export function canReuseAutoReviewAuthorization(
  policy: ToolAuthorizationPolicy | undefined,
  matcher: ToolAuthorizationMatcher | null,
): boolean {
  return policy?.reuseAutoReview === true && matcher?.type === 'exact';
}
