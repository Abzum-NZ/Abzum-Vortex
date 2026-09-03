# Issue 25 local identity-authority evidence

This directory records the browser-visible, local-only evidence for the neutral registration, confirmation, sign-in and password-recovery foundation. No customer data, credentials, tokens or provider secrets are included.

## Visual evidence

- `desktop-sign-in.png` and `phone-sign-in.png`: credential-free responsive sign-in page.
- `desktop-check-email.png` and `phone-check-email.png`: neutral recovery response that does not disclose whether an identity exists.
- `desktop-recovery.png` and `phone-recovery.png`: responsive password-recovery request page.
- `desktop-success.png` and `phone-success.png`: token-free password-update result page.
- `desktop-safe-failure.png` and `phone-safe-failure.png`: stable, non-diagnostic invalid-link response.

The browser snapshots are supporting UX evidence. The automated proof is authoritative for the security and lifecycle behavior.

## Reproducibility

- Implementation revision: `f57b7721f5abd2e2034d1cab17e13201f5f6b58e`
- Feature branch: `codex/issue-25-identity-authority`
- Supabase CLI: `2.116.0`
- `@supabase/supabase-js`: `2.114.0`
- Local authority: `http://127.0.0.1:54321/auth/v1`
- Local email capture: `http://127.0.0.1:54324`

The hosted Testing authority and exact merged Testing revision are recorded separately after the reviewed feature revision merges and the operated proof completes.

## Automated proof

Run from the repository root:

```text
pnpm auth:local:proof
pnpm --filter @vortex/identity test
pnpm --filter @vortex/identity typecheck
pnpm --filter @vortex/web typecheck
pnpm --filter @vortex/web build
```

The local proof drives the real App Router pages and server actions over HTTP. It creates an isolated disposable identity, confirms it through the server-side token hash, verifies the issued ES256 token through Vortex, requests recovery without disclosing account existence, changes the password, proves the old password fails and proves the new password succeeds. Confirmation and recovery token hashes travel in browser-only URL fragments and server-action request bodies, not request URLs, access logs or referrers. Generated credentials and tokens stay in process memory and are never printed or committed.
