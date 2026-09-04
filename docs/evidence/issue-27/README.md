# Issue 27 evidence

This directory records credential-free evidence for the organisation launcher and request-context delivery in [issue #27](https://github.com/Abzum-NZ/Abzum-Vortex/issues/27).

## Local browser proof

The disposable Local Supabase stack was rebuilt from the committed migration chain. One synthetic identity was given two independent active organisation accounts in two different tenants. The proof used the real Next.js server, Supabase Auth session, restricted `vortex_runtime` login, Access-owned scope resolver, transaction-local context and `vortex_request` validation.

| Check | Result |
|---|---|
| Safe launcher | Passed: only tenant, organisation and optional account display labels plus organisation routes were rendered. |
| First tab | Passed: `Harbour Operations` resolved at its own organisation address. |
| Second tab | Passed: `Lakes Operations` resolved at a different organisation address in the same Edge browser session. |
| Tab independence | Passed: reopening the first tab still showed only `Harbour Operations`. |
| Forged address | Passed: an unknown organisation identifier returned the neutral `Organisation unavailable` state and no organisation label. |
| Credential exposure | Passed: screenshots contain no email address, password, cookie, token, database address, tenant/account identifier or Access version. |

Screenshots:

- `local-launcher.png` — launcher with two safe choices.
- `local-tab-harbour.png` — first tab's selected organisation.
- `local-tab-lakes.png` — second tab's selected organisation.
- `local-forged-selection.png` — neutral refusal for an unknown selection.

## Automated proof

- `pnpm verify`: formatting, lint, TypeScript, 23-package boundary enforcement, 635 passing unit tests with three intentional skips, eight complete-fixture checks, and the production Next.js build passed.
- `pnpm db:verify`: 13 pgTAP files with 725 assertions, seven two-connection concurrency proofs, and Supabase database lint passed.
- The organisation-context concurrency proof shows an account-state writer waits while protected work holds its live scope and that the next request refuses the suspended account.

Hosted Testing evidence and the exact reviewed revision are added only after the protected feature-to-Testing delivery succeeds. Production database delivery is not part of this issue.
