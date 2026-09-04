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
- Independent review found and blocked a legacy caller-context transaction path. The production path was removed, protected Definition and Identity adapters now require an already-initialized request transaction, and boundary enforcement reserves resolved human-context composition to Access.

## Hosted Testing proof

| Check | Result |
|---|---|
| Reviewed feature revision | Passed: independent architecture and security review approved [`48f3361d56316cc3e30a94f1c129dcbe3350eae8`](https://github.com/Abzum-NZ/Abzum-Vortex/commit/48f3361d56316cc3e30a94f1c129dcbe3350eae8) with no material findings. |
| Protected Testing merge | Passed: [pull request #259](https://github.com/Abzum-NZ/Abzum-Vortex/pull/259) produced Testing commit [`5dd9f3d2a1cb405c77ae4afaed7350f5167f59f6`](https://github.com/Abzum-NZ/Abzum-Vortex/commit/5dd9f3d2a1cb405c77ae4afaed7350f5167f59f6). |
| Application deployment | Passed: Vercel deployed that exact Testing commit as [deployment `8LzJiUeJr4ndG7LpeifQREy5SuDy`](https://vercel.com/abzumdevteam/abzum-vortex/8LzJiUeJr4ndG7LpeifQREy5SuDy) at the stable [Testing site](https://vortex-testing.abzum.com). |
| Database delivery | Passed: [Kestra execution `7EWjNdCFDWM5iZUe2LASDl`](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/7EWjNdCFDWM5iZUe2LASDl/logs) validated the exact Testing commit, migration-set fingerprint `be62c1e78df3c90b7c5288a81459b4ccf9d7214fac75d932f1d4420f7bc1de35`, applied `20260905043000_organization_request_context.sql`, and completed the protected database verification successfully. |
| Two-tab browser journey | Passed: one temporary Testing identity opened `Harbour Operations` and `Lakes Operations` at two different organisation routes in the same signed-in browser. Each tab rendered only its own safe tenant, organisation and account labels; revisiting the first route still resolved the first organisation. |
| Forged selection | Passed: a syntactically valid but unknown organisation address returned the same neutral `Organisation unavailable` state without revealing a label or existence. |
| Responsive presentation | Passed: the selected-organisation page remained usable at the 390 × 844 phone viewport and at the default desktop viewport. Credential-free screenshots were captured from the live Testing browser journey. |
| Temporary proof data | Passed: the temporary Auth identity, Identity projection, two tenants, two organisations, two organisation accounts and Access-version rows were removed after the browser evidence was captured; a follow-up query returned zero matching Auth users and organisations. |
| Supabase advisers | Passed for this change: the security adviser reported only the deliberate private-table `RLS enabled, no policy` posture plus the Testing leaked-password setting already owned by [#171](https://github.com/Abzum-NZ/Abzum-Vortex/issues/171); the performance adviser reported the three existing foreign-key indexes tracked by [#235](https://github.com/Abzum-NZ/Abzum-Vortex/issues/235) and expected unused indexes in the newly rebuilt database. No issue was introduced by the organisation-context migration. See the [database-linter guidance](https://supabase.com/docs/guides/database/database-linter) and [password-security guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). |

Production database delivery was not run and remains separately gated.
