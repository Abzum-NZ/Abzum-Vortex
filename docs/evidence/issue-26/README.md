# Issue 26 verification evidence

This directory records credential-free evidence for the Identity-session implementation. It never
contains a cookie value, access token, refresh token, email address, password or provider profile.

## Local evidence

- A clean `pnpm db:verify` completed 12 pgTAP files and 701 assertions, all six existing real
  concurrency proofs, and schema lint with no errors.
- `pnpm auth:local:proof` completed the App Router registration, confirmation, sign-in, protected
  session, provider refresh characterization, second-browser isolation, local sign-out, recovery
  and replacement-password journey.
- The proof checked the separate Local cookie family, `HttpOnly`, `SameSite=Lax`, `Path=/`, absence
  of `Secure` on exact HTTP loopback, absence of `Domain`, complete sign-out removal, and absence of
  a durable application session after confirmation and recovery.
- Browser inspection found meaningful content, no framework overlay, no console error and no
  horizontal overflow at 390 pixels.

## Screenshots

| View | Evidence |
|---|---|
| Local desktop | [local-sign-in-desktop.png](local-sign-in-desktop.png) |
| Local phone, 390 × 844 | [local-sign-in-phone.png](local-sign-in-phone.png) |
| Protected Testing database delivery | [testing-kestra-delivery.png](testing-kestra-delivery.png) |

The authenticated neutral page is exercised by the automated Local and hosted Testing journeys.
Its cookie-bearing browser state is deliberately not copied into repository evidence.

## Hosted Testing evidence

- Feature commit: `2777644eeeecbe23f8cc519ce58a72af38f9ce5a`.
- Protected Testing merge: `16f9c509a360afd830c73ceb907f3f8e8d2325e3`, delivered by
  [pull request #246](https://github.com/Abzum-NZ/Abzum-Vortex/pull/246).
- Corrected Vercel Preview deployment: `7RS45p5PJEa4rXfZbmFyZ8BXXpqm`, serving the stable
  [Testing site](https://vortex-testing.abzum.com).
- Kestra execution `59nl9rvGYhFfqnyMvZUVx7` succeeded for the exact Testing merge. It applied
  migration `20260905010000_identity_projection_runtime_read.sql`, matched migration-set fingerprint
  `05acb651be1ab523f610f2b1a001afd0a0737f693ef14ed4694b924e85d4891c`, and completed all
  12 registered pgTAP files and 701 assertions.
- The Testing runtime was repaired with a newly rotated, environment-only restricted role credential,
  the official Supabase root certificate, the Testing environment name and one stable Testing Identity
  Authority identifier. Doppler's `stg` sync was checked against Vercel Preview, legacy general database
  and Kestra variables were removed from that sync target, and the exact Testing revision was redeployed.
- The complete hosted proof passed managed `ES256` JWKS verification, Mailtrap confirmation and
  recovery, server-only sessions, browser-isolated sign-out, an independent verifier, cross-environment
  refusal, neutral recovery and password replacement. The proof used temporary read-only operational
  access and deleted its local temporary credential files.
- Supabase Testing project `abflfptnguasinoussws` in `ap-southeast-2` was healthy. Existing adviser
  observations were either expected on private deny-by-default tables, transient, already tracked by
  [#235](https://github.com/Abzum-NZ/Abzum-Vortex/issues/235), or deferred to the operated security work
  in [#171](https://github.com/Abzum-NZ/Abzum-Vortex/issues/171); none blocked Identity sessions.

Production was not configured, contacted or approved for this issue.
