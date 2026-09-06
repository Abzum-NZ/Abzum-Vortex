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

## First checkpoint database bytes

| File | SHA-256 |
|---|---|
| `supabase/migrations/20260906101701_protect_organization_access_administration.sql` | `6a38b57e31ac47873c34a4059b81846db53c560b2994e2dc370144465f8f50ee` |
| `supabase/tests/330_organization_access_administration_foundation.test.sql` | `7d6d6dc530206bbdff6afd9e0d5b76c3b53fa5ad3dfbdf87c9ebe24f01dc90e4` |
| `supabase/tests/organization-access-administration-concurrency.test.sh` | `c2df5dce569195a4fb98dbb6ac35c438252f76dbe9cf0ac9be0da04caa492d9b` |
| `workflows/kestra/database-verification.json` | `cc8f63971161a2814d83fc6820ca660ef51d2db00ea65fca0d642255366b9adc` |
