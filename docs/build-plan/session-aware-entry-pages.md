# Session-aware public and sign-in pages

Task: [#350](https://github.com/Abzum-NZ/Abzum-Vortex/issues/350). [Current roadmap](README.md) · [Architecture review](architecture-review-2026-09-21.md)

## Functionality

The public homepage and sign-in page reflect the current session so an already signed-in person can continue to their organisation without another password form.

- Read the existing Proxy-owned marker server-side as a navigation hint. It grants no organisation or permission authority.
- A verified homepage offers **Continue to Vortex** at `/signed-in`; missing/invalid sessions offer **Secure sign in**. Unknown/unavailable state offers neutral **Account access**.
- A verified sign-in request redirects to the existing launcher, which still performs authoritative session and organisation checks. Missing/invalid sessions retain the form.
- Unavailable verification shows a neutral retry message, preserves cookies and avoids redirect loops. Retry requests a fresh document.
- Keep the homepage public and its session output request-specific. Existing tabs update on navigation/reload. Reuse the existing session provider and marker without polling, another session store or additional permission authority.

## Historical implementation

[PR #352](https://github.com/Abzum-NZ/Abzum-Vortex/pull/352) delivered this correction. Its dated deployment observations remain in the issue history. They are not current completion requirements or authorization to repeat hosted operations.

Current development completion is implementation plus independent code review. No tests, database review or hosted proof are required.
