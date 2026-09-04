# Issue 25 identity-authority evidence

This directory records the sanitized Local and hosted Testing evidence for the neutral registration, confirmation, sign-in and password-recovery foundation. No customer data, credentials, tokens, email addresses, one-time links or provider secrets are included.

## Verified revisions and environments

| Evidence | Exact value |
|---|---|
| Reviewed implementation on protected `main` | `6e65aba1d8ea8ee6d98813c1f856cfcbd6ad36a0` ([PR #236](https://github.com/Abzum-NZ/Abzum-Vortex/pull/236)) |
| Tested protected `testing` revision | `9d0ca972a77fa93ba7ea6adec209def457ec6aad` ([PR #237](https://github.com/Abzum-NZ/Abzum-Vortex/pull/237)) |
| Operated hardened proof runner | `04f51ed48996f9b23d367f377a954f57607ca248` |
| Executed secret-isolation regression | `592f9bc25422d6c8f62f8815170963b0c6c03b6d` |
| Tested Vercel deployment | `P6CzFfqGXnogoc1atQggW3EwWwwD` ([deployment details](https://vercel.com/abzumdevteam/abzum-vortex/P6CzFfqGXnogoc1atQggW3EwWwwD)) |
| Immutable deployment address | `https://abzum-vortex-1uyiculy3-abzumdevteam.vercel.app` |
| Stable Testing identity address | `https://vortex-testing.abzum.com` |
| Hosted identity authority | Supabase project `abflfptnguasinoussws` (`ACTIVE_HEALTHY`, Sydney) |
| Supabase CLI | `2.116.0` |
| `@supabase/supabase-js` | `2.114.0` |
| Local identity authority | `http://127.0.0.1:54321/auth/v1` |
| Local email capture | `http://127.0.0.1:54324` |

The Vercel deployment was built from the exact protected `testing` revision above. Testing and Production remain separate authority, deployment and secret contexts.

## Visual evidence

- `desktop-sign-in.png` and `phone-sign-in.png`: credential-free responsive sign-in page.
- `desktop-check-email.png` and `phone-check-email.png`: neutral recovery response that does not disclose whether an identity exists.
- `desktop-recovery.png` and `phone-recovery.png`: responsive password-recovery request page.
- `desktop-success.png` and `phone-success.png`: token-free password-update result page.
- `desktop-safe-failure.png` and `phone-safe-failure.png`: stable, non-diagnostic invalid-link response.

The browser snapshots are supporting UX evidence. The automated proofs are authoritative for security and lifecycle behaviour. No Mailtrap screenshot was created because its message list and message bodies contain generated addresses or single-use links.

## Hosted Testing configuration proof

The preflight and operated proof confirmed:

- the active Supabase project is the dedicated Testing project, not Production;
- email/password authentication requires email confirmation;
- unsupported providers and passwordless Vortex routes are absent;
- the exact Testing site and callback addresses are allowlisted without wildcard or provider-generated identity addresses;
- access tokens expire after one hour and refresh-token replay protection is enabled;
- new passwords require at least eight characters with at least one letter and one number;
- Testing uses a managed P-256/ES256 signing key whose JWKS contains public material only;
- no custom access-token hook adds tenant, organisation, account, role, application, grant, capability or permission authority;
- Supabase Testing uses Mailtrap Email Testing custom SMTP; both confirmation and recovery templates use Supabase's supported `{{ .ConfirmationURL }}`;
- the Mailtrap API token is viewer-only, restricted to the dedicated Testing sandbox, and expires on 4 September 2027; and
- the generated proof address, Mailtrap read credential and sandbox identifiers are isolated in Doppler `abzum-vortex/ops_stg`, which has no deployment sync. Deployable Testing values remain in `abzum-vortex/stg`.

No protected value is copied into source, a fixture, a browser bundle, an evidence file, a screenshot or command output.

## Automated proof

The verified commands are:

```text
pnpm auth:local:proof
pnpm auth:testing:proof
pnpm --filter @vortex/identity test
pnpm --filter @vortex/identity typecheck
pnpm --filter @vortex/web typecheck
pnpm --filter @vortex/web build
pnpm verify
```

The Local proof passed end to end. It drives the real App Router pages and server actions over HTTP, creates an isolated disposable identity, confirms it, verifies the issued ES256 token through Vortex, requests recovery without disclosing account existence, changes the password, proves the old password fails and proves the new password succeeds.

The hosted proof and final source review together established:

1. Vercel Deployment Protection refuses a Testing request without its bypass header and accepts the same request when the header is supplied.
2. Registration reaches the neutral acknowledgement, and the unconfirmed identity cannot sign in.
3. Mailtrap captures the confirmation message, whose link uses the Testing Supabase verification authority.
4. Supabase consumes the one-time link and redirects only to the exact allowlisted Vortex confirmation callback with its documented implicit-flow session fragment.
5. The callback removes the complete fragment before validation or submission, sends only the access token and `signup` purpose in the same-origin server-action body, and creates no durable browser session.
6. The confirmed identity signs in, and two independently constructed verifiers return the same permanent identity and verified email facts.
7. A local issuer comparison refuses the real Testing token when configured for the public Production issuer; it sends no token or request to Production.
8. Mailtrap captures recovery, Supabase returns the exact recovery callback, and the request-local access/refresh pair updates the password without persisting a session.
9. The former password fails, the replacement succeeds, and recovery for an unknown address returns the same neutral acknowledgement.

The proof-only bypass value is sent only in Vercel's documented `x-vercel-protection-bypass` header to the exact Testing origin. Redirect handling cannot forward it. Production inputs contain public authority metadata only. No Production Vortex or Supabase request, email, configuration change or write occurs.

The final independent review identified and resolved one low-risk proof-tooling issue: the spawned verifier now receives only required operating-system launch values and its six explicit verifier inputs. Mailtrap, Vercel-bypass and unrelated parent secrets cannot enter that child process. The complete hosted proof passed again with the hardened runner. A regression test injects unrelated sentinel values, proves they are absent, and runs in the standard Identity suite.

## Secret and log handling

Generated credentials, session material and one-time links exist only in process memory and are never printed. Confirmation and recovery fragments are copied in memory, immediately removed from the visible address and history, and then submitted through same-origin request bodies. `persistSession`, automatic refresh and URL-session detection remain disabled; [issue #26](https://github.com/Abzum-NZ/Abzum-Vortex/issues/26) is the sole owner of durable session lifecycle.

The full repository gate passed after the implementation change: formatting, lint, 23 package typechecks, boundary rules, 544 tests passed with 3 explicitly skipped, 8 fixture tests, 23 package builds and the Next.js production build.
