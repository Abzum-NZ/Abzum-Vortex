# Session-aware public and sign-in pages

Task: [#350](https://github.com/Abzum-NZ/Abzum-Vortex/issues/350).

## Problem and scope

The public homepage always offers sign-in, and the sign-in page always renders a
password form even when the same browser is already authenticated. Fresh Testing
navigation reproduces both behaviours. These pages currently ignore the session
state; this is not evidence that the protected organisation session was lost.

## What to build

1. Read the existing Proxy-owned session marker with Next.js server-side
   [headers](https://nextjs.org/docs/app/api-reference/functions/headers).
   Treat this only as a navigation hint, never organisation or permission authority.
2. On the homepage, offer **Continue to Vortex** at `/signed-in` when verified;
   retain **Secure sign in** when missing/invalid. For an unavailable or unknown
   state offer neutral **Account access**, without asserting that the user is out.
3. On `/auth/sign-in`, verified sessions
   [redirect](https://nextjs.org/docs/app/api-reference/functions/redirect) to the
   existing `/signed-in` launcher. That launcher retains its authoritative session
   and organisation checks. Missing/invalid sessions keep the existing form.
4. If verification is unavailable, show a neutral retry message on the sign-in
   page, not a logged-out assertion or an automatic redirect loop. Leave existing
   session cookies untouched. No separate session store, browser polling, extra
   database lookup, or authentication/permission changes.
5. Keep the homepage public and session-dependent output request-specific. Existing
   tabs update on their next navigation/reload; live cross-tab synchronization is
   not part of this repair.

## Acceptance and delivery

- Verified homepage has the continuation link; verified sign-in redirects without
  rendering another password form. The destination still enforces access.
- Missing/invalid sessions retain the sign-in journey and signed-out status.
- Unknown/unavailable state does not falsely say signed out or destroy cookies.
- Focused page tests cover all marker states. Existing Proxy tests prove caller
  markers are replaced. Auth, organisation, type, lint and boundary checks pass.
- An independent Sol reviewer reviews the actual patch. Normal preview checks pass
  before merging. Verify both URLs in the signed-in Testing browser after deploy
  and capture the resulting interface without credentials.

This is a small Phase 2 identity-journey correction supporting current Phase 3
access delivery, not an App Builder or new authentication framework task.

## Implementation evidence — 8 September 2026

The correction uses the existing Proxy-owned request marker and a small shared
navigation-hint reader. The unavailable-state retry uses an ordinary link that
requests a fresh document, avoiding reuse of a same-route client navigation.
Protected session and organisation resolution are unchanged.

All 13 entry-page tests and all 58 web tests across eight files pass. Web typecheck,
scoped lint, formatting, all 23 package boundaries and diff checks pass. Independent
actual-patch review and deployed browser evidence are recorded with the task before
closure; these local checks alone do not establish hosted completion.

## Deployed outcome

[PR #352](https://github.com/Abzum-NZ/Abzum-Vortex/pull/352) merged normally as
Testing `d2952833da0340db5573925516a33e2cd58989f2` after independent Sol approval.
[The Testing deployment](https://vercel.com/abzumdevteam/abzum-vortex/GRFY6UtM2dC9H1rh7dAiw1kSCLzM)
was Ready. In the existing signed-in Edge session, the public homepage offered
**Continue to Vortex** and opening the sign-in address returned to the signed-in
organisation. [The task's completion record](https://github.com/Abzum-NZ/Abzum-Vortex/issues/350#issuecomment-5581421989)
records the browser verification. The task is Done; already-open old pages need
their next refresh/navigation to show the corrected state.
