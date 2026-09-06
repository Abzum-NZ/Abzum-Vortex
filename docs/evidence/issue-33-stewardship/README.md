# Issue 33 D1 permanent stewardship evidence

## Delivered boundary

The private adoption operation appoints an explicitly named active organisation
account. It creates only the thirteen platform-management permissions, one direct
permanent standing assignment and separate permanent catalogue delegation. It
creates no application-data access, identity, public endpoint or IAM interface.
[Provisioning #30](https://github.com/Abzum-NZ/Abzum-Vortex/issues/30) remains
responsible for confirming the identity and account in its outer transaction.

One current requirement records original adoption provenance. Current facts, not
that record alone, determine whether an administrator qualifies. Exact replay
can succeed after legitimate replacement and suspension of the original account;
it returns current Access evidence without restoring the original grants.

The existing Access-owned role, assignment, delegation and account-state writers
now check that a permanent administrator remains before committing. The shared
organisation lock serializes competing changes. Failure rolls back both the
mutation and its Access increment. Raw Identity operations are unchanged; future
identity lifecycle compositions must use this safeguard as specified in the
[build plan](../../build-plan/README.md).

Current catalogue identity, permission meaning and continuity establish authority.
Registration-processing metadata is not another authority predicate: a supported
metadata-only catalogue revision need not revoke unchanged accepted permissions.
No extra counter, approval store, copied permission snapshot or timestamp ordering
mechanism was introduced. Independent Sol review approved the complete D1
implementation against its task requirements and challenged unnecessary guards.

## Verification

On the local database with 35 migrations through `20260906023032`:

- All 34 SQL test files passed, with 1,690 assertions. The focused stewardship
  file contributes 55 assertions: initial and existing continuity, unrelated
  application authority, accepted extra permissions, last-administrator removals,
  replacement/replay and whole-statement rollback on Access exhaustion.
- All 17 manifest-listed separate-session concurrency proofs passed. The new
  proof observes the second removal blocked by the first transaction, then
  verifies that it refuses rather than removing the remaining administrator.
- Lint completed across all five schemas with no errors. Three existing warnings
  remain: two unused variables in application-access coordination and a text to
  UUID initialization in the platform-catalogue helper. No new stewardship warning
  was reported.
- The full repository gate passed: 1,134 tests with three existing skips, 76
  passing test files with two skipped files, all eight fixtures, and all 23 package
  typechecks, builds and boundary checks. Typechecks and builds ran without cached
  results in this worktree on the first complete run.

The first expanded SQL run exposed a test-fixture column typo, which was corrected.
An overlapping SQL/concurrency run also affected four existing global-count
assertions; the complete SQL suite passed unchanged after concurrency cleanup.
These suites must run sequentially against one shared database, as the delivery
sequence already requires. No new framework or infrastructure change was needed.

SQL acceptance fixtures roll back; concurrency cleanup is restricted to its
uniquely identified owned fixture. This evidence makes no hosted-environment or
user-interface claim. D2 management-application binding and E invitation
integration remain separate unfinished parts of
[#33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33).

## Frozen artifacts

- `20260906023032_coordinate_organization_stewardship_adoption.sql`:
  `54e64301196ce00189423c8b7ea1b834cc59d7f891ae9dc95a3fc8528b95b9c6`
- `260_organization_stewardship_adoption.test.sql`:
  `e1b2cf59a30a4b8f87154282a37d175d42fc7f32fc5a72c8287e04e7b4b9c5bf`
- `organization-stewardship-concurrency.test.sh`:
  `8aa08ae7bed7c96f26ed4f374af34f3cf72e9f90af4a163666e5d9fbf6384d66`
- `workflows/kestra/database-verification.json`:
  `30a5a2a3b871cea83a5e83d138b9adb1fa903951afbfd682f862ad978f0e1f5e`
