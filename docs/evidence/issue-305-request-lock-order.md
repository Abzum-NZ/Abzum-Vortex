# Request and account-change ordering — issue 305

[#305](https://github.com/Abzum-NZ/Abzum-Vortex/issues/305) corrects the existing
organisation reader, not role policy. A request now selects its exact active scope
and locks only the organisation's Access version first. The authoritative Identity
resolver then locks and rechecks the same tenant, organisation and account.
The supported account-state writer already follows that order.

This removes the demonstrated opposite-order cycle without a retry framework,
another context, new table or new privileged endpoint. The function signature,
closed invalid/unavailable errors and runtime-only invocation remain unchanged.
Foreign and ineligible candidates fail before taking an unrelated Access lock.

## Verified locally — 6 September 2026

- Independent Sol review approved the actual source and tests against the full issue.
- One additive migration applied locally; 39 migrations are now present. No reset,
  signing-key change or hosted mutation was used for these checks.
- Focused context checks: 23 assertions passed, including null/nil input regressions.
- Full database suite: 36 SQL files / 1,815 assertions passed.
- All 19 manifest concurrency proofs passed through the standard runner. The
  corrected proof invokes the real Access-owned account writer in both orders:
  reader first holds a valid request until commit; writer first causes the waiting
  request to refuse the suspended account. Exact blocking sessions, resulting
  account revision/Access version, foreign refusal and owned cleanup are checked.
- Five-schema lint passed with no errors and the same three existing warnings:
  two unused application-coordinator variables and the catalogue helper's
  text-to-UUID initialization. This correction adds no warning.
- Repository verification including the accompanying #34 contract slice passed:
  1,196 tests with three existing skips, eight fixtures, all 23 package typechecks,
  builds and boundary checks, formatting and lint.

An initial ad-hoc PowerShell pipe appended a carriage return after the otherwise
passing focused race. The standard Node runner passed unchanged source and clean
fixture cleanup; no product or test-code change was made for the invocation artifact.

## Frozen source

- [Migration](../../supabase/migrations/20260906052556_align_organization_request_scope_lock_order.sql):
  `c1618be4805d668891f7e30cd0638a405c19b0597647ee1c5b94690eb98d6134`.
- [Context test](../../supabase/tests/120_organization_request_context.test.sql):
  `7ad5581b5c3b9d03ce23007df62d45c52ffd47f70c08243a60f5cdd0f30f1fdd`.
- [Concurrency proof](../../supabase/tests/organization-request-context-concurrency.test.sh):
  `3ff64569c0219886b7bd5130bd08561d2bee571644cb19b43d945e9c0b141e3b`.

## Delivery boundary

Normal pull-request and exact hosted verification remain required. Local evidence
does not claim Testing or Production delivery. [#34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34)
continues the permission decision; [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40)
must authorize and mutate inside its governance-first writer transaction, not
upgrade a previously resolved read transaction's shared lock.
