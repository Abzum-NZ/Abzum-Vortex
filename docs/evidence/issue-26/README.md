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

The authenticated neutral page is exercised by the automated Local and hosted Testing journeys.
Its cookie-bearing browser state is deliberately not copied into repository evidence.

## Hosted Testing evidence

The exact protected Testing execution, secure hosted-cookie result, adviser output and deployed
revision are recorded here after feature-to-Testing delivery. Production is not contacted.
