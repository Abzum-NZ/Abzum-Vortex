# Protected Access administration evidence

Task: [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40). Scope and acceptance: [implementation plan](../build-plan/issue-40-protected-access-administration.md).

## First implementation checkpoint — 6 September 2026

The first bounded implementation adds the governance-first verified human request path and permitted Group list/detail operations. It reuses current Identity, the central Access decision and existing Group facts. It does not deliver mutation endpoints, every administration projection, the IAM interface or the whole task.

The organisation/application change resolvers take the existing organisation write lock before rechecking mutable account and application facts. Only the trusted runtime can call those resolvers. Group readers use the existing exact catalogue permission and return bounded summaries through the restricted request role. No private helper or table is opened to ordinary clients; no second permission engine, approval store or business-domain behaviour is added.

| Evidence | Result |
|---|---|
| Focused contract/service tests | 17 tests pass; contracts and Access typechecks pass |
| Actual restricted-role database coverage | New suite passes all 49 assertions, including permitted/forbidden Group reads, foreign and stale scope, and the real application resolver |
| Full local database suite | 41 files, 2,005 assertions pass |
| Concurrent-change coverage | All 22 selected proofs pass, including organisation/account locking and actual application withdrawal versus the new application resolver |
| Security and database lint | Local security advisors report no issues. All six selected schemas lint without errors; three previously existing Access warnings remain, none introduced here |
| Independent actual-patch review | Sol approved the final implementation and corrected application-resolver proof; no remaining source finding |
| Repository-wide check | Full verification passes: 1,238 tests, three existing skips, eight fixture checks, 23 package typechecks/builds, formatting/lint and package boundaries |
| Hosted delivery | [PR #312](https://github.com/Abzum-NZ/Abzum-Vortex/pull/312) merged into Testing after both normal preview checks passed; the exact hosted database receipt is still pending verification |

The existing local PostgreSQL 17.6 database had 43 migrations before the additive change. The CLI-created migration `20260906101701_protect_organization_access_administration.sql` was applied and iterated locally without resetting data. Once final SQL and concurrency checks passed, the supported local migration-history command recorded that already-applied migration, and the local list confirmed all 44 entries match. No hosted migration history, Production deployment or infrastructure was changed by that local operation.

Review and execution corrected three narrow issues before the passing checkpoint: the application resolver needed an actual database/concurrent-withdrawal test rather than only a transaction mock; the Group-detail SQL output was renamed from the reserved word `group` to `group_summary`; and two assertions were corrected to the existing stale-context error and catalogue-initialised Access version. Public Group results still use the existing `group` property.

One earlier full database run observed a failure in the unchanged Access-version suite: its exhaustion test expected `22003` but received stale-account `40001`. The isolated original suite and the final complete suite both passed without changing that test or its implementation. The cause was not established; this is not evidence that a local clock issue was repaired. A first ad-hoc PowerShell transport also appended a carriage-return line after the new shell proof had passed; running the exact UTF-8 source through the normal Node runner passed. No source workaround was added for either observation.

There is no new user interface to screenshot. Remaining permitted reads, non-grant changes with Activity, private governed handoffs and exact hosted verification remain part of [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40).

## Testing merge

The approved source `9b23a4219e7cd27e99947109c5ba29438cef09e0` merged normally at `2026-09-06T11:11:27Z` as `35b09d1995a56656cbe6f0401666145e4853bd82`; the merge changed no reviewed file bytes. Both Vercel and Vercel Preview Comments succeeded. No required check was bypassed. Read-only inspection of the hosted receipt could not be completed because the Edge browser controller reported a detached/unattached debugger. The ordinary [Kestra KV page](https://kestra.abzum.com/ui/main/kv) opened, but its receipt content was not readable through the connected tool. This is not evidence of a failed hosted run, nor of a successful one. Core implementation continues while the exact result remains unverified; no API workaround, new credential or infrastructure change was attempted.

## Group membership read checkpoint — 6 September 2026

The next bounded slice adds one selected-Group membership page and one exact membership detail. It reuses the existing fixed Group-read permission and shared Access lock; no new permission evaluator or concurrency harness is introduced. Results contain stable references, the existing safe account display name, revision, time window, stored state and descriptive temporal state. `live` storage state is distinct from `active`, `scheduled` or `expired` temporal state; none is an effective-permission decision. Unknown and foreign targets are unavailable without disclosing which case occurred.

Independent Sol review approved the exact six implementation files. The initial transaction-only probe passed all 36 new assertions and rolled back the new index, functions and fixtures. The approved migration was then applied locally: all 42 suites / 2,041 SQL assertions and all 22 existing concurrency proofs passed. All six schemas lint without errors and retain only the same three previous Access warnings; local security advisors report no issues. The supported local history command recorded the already-applied migration, bringing the local total to 45. No hosted database was changed by this local operation.

The engineer's focused contract/service check passes 11 tests, with contracts and Access typechecks plus scoped formatting/lint. The combined working-tree repository gate subsequently passed 1,256 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. That run also included the shared-condition implementation and parallel catalogue runtime/test changes; it is not hosted-delivery evidence. This remains a local implementation checkpoint, not part of the earlier Testing merge.

| Frozen database file | SHA-256 |
|---|---|
| `supabase/migrations/20260906110758_protect_organization_group_membership_administration.sql` | `6647b7b991969088557063f4e399666c886cc6f20c398097719b5f02bba790ea` |
| `supabase/tests/335_organization_group_membership_administration.test.sql` | `ea9a86b58abcad0b03ac7a291ee9b56b2c2df0b849d32fdfa716dabfba033fc5` |

The membership and shared-condition checkpoint merged normally through [PR #313](https://github.com/Abzum-NZ/Abzum-Vortex/pull/313) at `2026-09-06T11:55:55Z`, after Vercel and Vercel Preview Comments succeeded. Source `2435f3e79991af919b77943413fec21fdd94fd70` and Testing merge `b1cdd1ea466d583e32f561ea9ae0f46de22b587f` have identical file trees. The later catalogue work was excluded from that commit. A bounded read-only retry could list the existing Edge tabs, but selecting the normal Kestra KV tab timed out; the exact hosted database receipt remains unverified. No controller/API bypass, credential change, Production promotion or infrastructure work was performed.

## Group create and rename checkpoint — 7 September 2026

Permitted administrators can now create a Group and rename an existing Group through separate protected commands. Renaming preserves its identity and key and requires the expected revision. Both operations reuse the organisation lock, current account and fixed Group-management permission, update Access once and record one content-free Activity in the same transaction. Creating or renaming a Group does not grant roles, add members or delegate authority. Broader administration and IAM screens remain outside this checkpoint.

Independent Sol review approved the final eight implementation/test files. Focused contract/service checks passed 16 tests, the restricted-role database proof passed 23 assertions, and a new concurrent-rename proof established one winner and one stale refusal with no partial change. The selected hosted verification manifest includes that proof as its 23rd concurrency check; this source change is not evidence that a hosted run executed it.

The final combined local repository verification passed formatting, lint, typechecks, boundaries, tests, fixtures and builds. All 44 database files / 2,087 assertions passed. Local security advisors found no issues; six-schema lint retained only the same three earlier warnings. The concurrency runner passed checks 1–18 before an existing invitation acceptance check failed; an explicit run of checks 19–23 then passed all five, including the new Group check. Thus every selected proof passed, but not in one uninterrupted run. An earlier full SQL run also encountered the existing invitation account-reactivation failure; the isolated test and final complete suite passed unchanged.

Source diagnosis identified an invitation writer using a statement-start audit timestamp sampled before serialization waits, which can be older than the locked invitation/account audit value. [Invitation acceptance #315](https://github.com/Abzum-NZ/Abzum-Vortex/issues/315) records the narrowly scoped follow-up correction, not evidence that the Docker clock was repaired. Revision and Access ordering must remain authoritative; real expiry checks must not use a clamped audit timestamp. No service restart or infrastructure change was made.

The additive migration `20260906115410_protect_organization_group_administration_changes.sql` was applied locally without resetting data. Supported migration history now records all 47 applied entries. The final database proof and race source hashes are recorded below. Hosted Testing receipts remain unverified; no Production promotion is claimed.

The Group-change and catalogue-scope source checkpoint merged normally through [PR #314](https://github.com/Abzum-NZ/Abzum-Vortex/pull/314) at `2026-09-06T12:33:57Z`. Source `87540f7c3414ee295d4c4f0f82702153b7b376a7` and Testing merge `04819359e55d9176eec7fe3665cd3fb76f32af56` have identical file trees. Both normal preview checks passed. The subsequent invitation correction is not included in this merge.

| File | SHA-256 |
|---|---|
| `20260906115410_protect_organization_group_administration_changes.sql` | `3a9d7d4c7f309bfc1fbdfd0223052400f6d63858e0dbaf1b0566b2fe15c3886d` |
| `350_organization_group_administration_changes.test.sql` | `4b291dda537f3296d64c5b98051bbeee4ccee2c9fda4291fad4cd195b883d3c9` |
| `organization-group-administration-change-concurrency.test.sh` | `42fe67c792857645da9fbd445da4cd62336af6593eca0bc0304a3026d02cfa3a` |
| `workflows/kestra/database-verification.json` | `666c66c3c50e18d11c7f650e7c02e54b5482fd88b566f6d76978906ac8de8c77` |

## Registered permission catalogue checkpoint — 7 September 2026

Permitted administrators can browse and inspect current registered permissions in their selected organisation. The same module permission installed in two applications has distinct contextual references. Only entries from active current registrations appear; withdrawn and historical entries do not. A current declaration awaiting role acceptance remains visible, but catalogue visibility grants no use, assignment or delegation authority. Results exclude raw record scope, publication fingerprints, source preparation and audit internals. No IAM page or granting endpoint is delivered by this checkpoint.

Independent Sol review approved the six frozen implementation/test files. Root's rollback-only database execution found one test defect: concatenating an intentionally null platform application reference made the whole expected cursor string null. The assertion was corrected to compare typed columns, including the actual null, and independently re-reviewed. The corrected rollback proof passes all 25 assertions; the migration itself did not change after review.

The exact reviewed migration was then applied locally without resetting data, and supported local history recorded the 49th migration, `20260906130257`. All 46 database suites / 2,125 assertions pass. Six-schema lint reports no errors and only the same three pre-existing Access warnings. Security advisors report no warnings or errors; their 29 informational notices describe the deliberately policy-free, deny-by-default private tables, not newly exposed access. Full repository verification passes 1,270 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. The runner uses the globally installed Turbo 2.10.12, matching the declared version, and reports its existing local-install warning.

This read-only slice adds no lock path or writer. It reuses the existing governance/read transaction and its previously passing 23 concurrency proofs recorded in [the invitation correction evidence](issue-315-invitation-audit-time.md); that is reused evidence, not a claim of a new concurrency run. The parallel unfinished database-condition migration was not applied or included in these database results. Exact hosted delivery is not yet verified. There is no new interface to screenshot.

The permission-browsing checkpoint merged normally through [PR #317](https://github.com/Abzum-NZ/Abzum-Vortex/pull/317) at `2026-09-06T13:36:12Z`. Both preview checks passed. Reviewed source `a646a3de62d9cb43d51e48e0fa2ece7788bb4c2a` and Testing merge `89f822ae5a53864dad665fd15d0846f7e7ce3880` have identical file trees. No check was bypassed, and unfinished condition work was excluded. This proves source delivery to Testing, not hosted database success or Production promotion.

| Frozen database file | SHA-256 |
|---|---|
| `supabase/migrations/20260906130257_protect_organization_permission_catalogue_administration.sql` | `6562a59beb1112b9a8ae4116328c87878e3ebd65fa732ab498dfff8c3f56ef53` |
| `supabase/tests/360_organization_permission_catalogue_administration.test.sql` | `2887b58929af6ba04a76bf27a97fa8de3355303a3417921293bbd936f282207e` |

## Local roles and registered application templates — 7 September 2026

Permitted administrators can list and inspect their organisation's current role configuration, including roles awaiting acceptance, unavailable roles and retired roles. Details preserve the exact accepted permission snapshot; pending additions do not silently appear as accepted. Safe policy settings explain standing versus activation-required access without exposing internal evidence. Application role templates are a separate resource, identified by both application and source role, and come only from the exact release selected by the active current registration. Neither view claims effective access or grants authority.

Independent Sol review approved the six implementation/test files. The main architect's rollback proof passes **31 database assertions**, including actual restricted-role permission checks, current versus historical configuration, cross-organisation refusal, bounded complete cursors, removed/withdrawn templates and safe output. Test setup was corrected to follow existing source-evidence constraints, insert accepted entries before sealing revisions, classify administrative custom roles as privileged, and explicitly group a JSON text extraction before concatenation. No production constraint or permission rule was relaxed.

Focused contracts/service checks pass **29 tests**, with both package typechecks and targeted formatting/lint. The prior combined repository gate with this frozen TypeScript implementation passed 1,279 tests with three existing skips, eight fixture checks, all 23 package typechecks/builds, formatting/lint and boundaries. The reviewed role migration was applied locally with the separately reviewed [revocation audit correction](issue-318-assignment-revocation-audit-time.md), bringing local history to 52 migrations. Complete regression results and normal Testing delivery are recorded separately when available; no hosted success or usable IAM screen is claimed by these local checks.

| Frozen database file | SHA-256 |
|---|---|
| `20260906133622_protect_organization_role_catalogue_administration.sql` | `dbf4f591f89bf654d17ec574e119fe415ce24bb132ca8a3643f4b30bea1c420d` |
| `370_organization_role_administration.test.sql` | `86f96900d19a3ad823368ff51cf5919fbfcbecc44e4bffcef2300444270eae2f` |

The final combined run also includes the reviewed current-person condition extension: **49 SQL suites / 2,249 assertions** and **1,280 repository tests** pass, with three existing skips, eight fixture checks and all 23 package typechecks/builds. All 23 existing concurrency checks pass across multiple runs, not one uninterrupted run; [the revocation evidence](issue-318-assignment-revocation-audit-time.md#actual-verification) retains the unrelated intermittent permanent-steward observation and its limited diagnosis. Lint has no errors and only previously reviewed warnings; security advisors report no issues. Local history now contains 53 migrations. No new concurrency framework or clock change was introduced.

The role/template source checkpoint merged normally through [PR #320](https://github.com/Abzum-NZ/Abzum-Vortex/pull/320) at `2026-09-06T14:30:34Z`. Both normal preview checks passed. Reviewed source `ca3d6d6ee89cb143c2986dec1d36d1183d26e748` and Testing merge `e8313abf386338db45dc9cdc9938bba42a78a6a9` have identical file trees. Exact hosted database delivery remains unconfirmed. The next assignment/delegation ledger is not included in this merge, and this checkpoint does not complete #40.

## First checkpoint database bytes

| File | SHA-256 |
|---|---|
| `supabase/migrations/20260906101701_protect_organization_access_administration.sql` | `6a38b57e31ac47873c34a4059b81846db53c560b2994e2dc370144465f8f50ee` |
| `supabase/tests/330_organization_access_administration_foundation.test.sql` | `7d6d6dc530206bbdff6afd9e0d5b76c3b53fa5ad3dfbdf87c9ebe24f01dc90e4` |
| `supabase/tests/organization-access-administration-concurrency.test.sh` | `c2df5dce569195a4fb98dbb6ac35c438252f76dbe9cf0ac9be0da04caa492d9b` |
| `workflows/kestra/database-verification.json` | `cc8f63971161a2814d83fc6820ca660ef51d2db00ea65fca0d642255366b9adc` |
