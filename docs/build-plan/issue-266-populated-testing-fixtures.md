# Verify accounts and roles in a populated Testing database

Task: [#266](https://github.com/Abzum-NZ/Abzum-Vortex/issues/266).
Affected delivery: [Page #38](https://github.com/Abzum-NZ/Abzum-Vortex/issues/38).

## Demonstrated problem

[Execution 2RMK74QpwbkNYtQRHPY4gN](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/2RMK74QpwbkNYtQRHPY4gN)
ran Testing commit `bfc75202ff870c10eff1c6bc424134a7d61a8fa8` and failed
invitation assertions 47/51 and role-storage assertion 35. These tests count all
organisation accounts/roles and assume the database contains only their fixtures.
Testing legitimately contains an unrelated account and role. Neither belongs to
the reserved fixture organisations. The merge changed neither test nor migration.
The adjacent activation-policy count contains the same empty-database assumption.

## Small repair

1. Scope the two invitation account-count assertions to their fixture organisation.
   Preserve the expected inviter count of one: invitation creation and wrong-email
   refusal must not create an account there.
2. Check both role and activation-policy absence in the two newly created fixture
   organisations, immediately after their creation and before explicit Access
   initialization. Existing roles elsewhere are legitimate, not a test failure.
3. Change only the two existing SQL test files. Retain their transactions and
   rollback, security checks, operation calls and expected outcomes. No migration,
   cleanup of existing data, reset, skip or new testing framework.
4. Independently review the actual patch, run the affected and complete database
   suites against the existing verified Local target, then use normal hosted
   delivery. Keep previous failed runs failed; do not fabricate a success receipt.

## Acceptance

- The existing checks continue to detect an unwanted account in the invitation
  organisation or implicit role/policy creation in the new fixture organisations.
- Unrelated existing accounts, roles and policies do not change the outcome.
- All existing SQL assertions remain enabled. Both affected suites and the full
  suite pass; normal hosted verification must finish concurrency/schema checks
  and record its exact revision before downstream task closure.
- Fixtures roll back and existing data is preserved. No product permissions,
  authentication, database schema or deployed verification flow changes.

This is an engineering correction under the existing verification task, not a
business decision, Kestra maintenance task or new release approval gate.

## Local evidence — 8 September 2026

Independent Sol review approved the exact two-file patch. Both affected suites
(156 assertions) and the exact 60 tracked SQL suites (2,670 assertions) pass.
Local already contains 71 migrations, including three previously applied untracked
Phase 3 migrations; this is supplemental compatibility evidence, not the exact
68-migration hosted Testing baseline. Untracked tests were excluded. An initial
full run encountered an unrelated timestamp abort in unchanged suite `040`; its
49 assertions passed alone and one bounded complete retry passed. Reserved
organisation/account/role/policy fixture counts were all zero after rollback.
No schema was changed or reset. Hosted exact-revision evidence remains required.

## Hosted outcome — 8 September 2026

[PR #351](https://github.com/Abzum-NZ/Abzum-Vortex/pull/351) merged normally.
[Testing execution 6WIfY1e5pRWu8lkswspG6M](https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/6WIfY1e5pRWu8lkswspG6M/outputs)
succeeded for `c89ae494a98edb4f2815004329ffc737d824667e` on the exact
68-migration baseline. All 60 SQL files / 2,670 assertions passed; all 25 selected
concurrency proofs and all six schema checks completed. Root read the complete
success receipt and matched its runner/manifest hashes and coverage lists to
that exact Git commit. [The Page evidence](../evidence/issue-38-native-page-handoff.md#successful-hosted-verification)
records those hashes and confirms the reviewed Page implementation is unchanged.

This bounded repair is complete and #38 is closed. The broader #266 task remains
open for its outstanding delivery-evidence reconciliation and normal Production
outcome. No Production completion, queue cancellation or Kestra upgrade is claimed.
