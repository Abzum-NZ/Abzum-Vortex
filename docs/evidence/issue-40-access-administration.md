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
| Hosted delivery | Pending for this checkpoint; local success is not hosted completion |

The existing local PostgreSQL 17.6 database had 43 migrations before the additive change. The CLI-created migration `20260906101701_protect_organization_access_administration.sql` was applied and iterated locally without resetting data. Once final SQL and concurrency checks passed, the supported local migration-history command recorded that already-applied migration, and the local list confirmed all 44 entries match. No hosted migration history, Production deployment or infrastructure was changed by that local operation.

Review and execution corrected three narrow issues before the passing checkpoint: the application resolver needed an actual database/concurrent-withdrawal test rather than only a transaction mock; the Group-detail SQL output was renamed from the reserved word `group` to `group_summary`; and two assertions were corrected to the existing stale-context error and catalogue-initialised Access version. Public Group results still use the existing `group` property.

One earlier full database run observed a failure in the unchanged Access-version suite: its exhaustion test expected `22003` but received stale-account `40001`. The isolated original suite and the final complete suite both passed without changing that test or its implementation. The cause was not established; this is not evidence that a local clock issue was repaired. A first ad-hoc PowerShell transport also appended a carriage-return line after the new shell proof had passed; running the exact UTF-8 source through the normal Node runner passed. No source workaround was added for either observation.

There is no new user interface to screenshot. Remaining permitted reads, non-grant changes with Activity, private governed handoffs and exact hosted verification remain part of [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40).

## Reviewed database bytes

| File | SHA-256 |
|---|---|
| `supabase/migrations/20260906101701_protect_organization_access_administration.sql` | `6a38b57e31ac47873c34a4059b81846db53c560b2994e2dc370144465f8f50ee` |
| `supabase/tests/330_organization_access_administration_foundation.test.sql` | `7d6d6dc530206bbdff6afd9e0d5b76c3b53fa5ad3dfbdf87c9ebe24f01dc90e4` |
| `supabase/tests/organization-access-administration-concurrency.test.sh` | `c2df5dce569195a4fb98dbb6ac35c438252f76dbe9cf0ac9be0da04caa492d9b` |
| `workflows/kestra/database-verification.json` | `cc8f63971161a2814d83fc6820ca660ef51d2db00ea65fca0d642255366b9adc` |
