# Issue 33 D2 management-application stewardship evidence

## Delivered boundary

An adopted organisation can activate or replace one exact management-application
requirement. It stores only the application root, organisation-local application
role and immutable required role revision on the existing stewardship requirement.
Existing sealed permission entries supply the required set. There is no copied
permission snapshot, new history, counter, approval store or application-name rule.

Activation and replacement are private, changed-only, revision-checked operations.
At least one account must satisfy both permanent platform stewardship and the
required direct, already-started, non-expiring operating assignment. An application
role existing somewhere in the organisation is insufficient. Replacement validates
the complete new condition without requiring stale old authority to become current.
The requirement and Access each advance once, or neither changes.

The shared safeguard checks continuously retained required permissions through
metadata changes and pending additions. The existing role, assignment, delegation
and account guards inherit it. One additional wrapper protects the actual
application-access composition from withdrawing the final required application.
The original adoption response and its non-reviving replay remain unchanged.

This private invariant does not implement the installed IAM interface or authorise
its callers. [Access #34](https://github.com/Abzum-NZ/Abzum-Vortex/issues/34),
[protected invocation #40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40),
[installation #64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) and
[IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267) retain those duties.
Invitation integration remains unfinished in
[#33](https://github.com/Abzum-NZ/Abzum-Vortex/issues/33).

## Verification

The local database has 36 migrations through `20260906033309`.

- All 35 SQL test files passed, with 1,745 assertions. The focused D2 file has
  55 assertions covering the private boundary, exact activation/replacement,
  stale and invalid targets, split-account refusal, old-source recovery,
  retained required permissions, final operating-assignment/source removal and
  atomic requirement/Access exhaustion.
- All 18 manifest-listed separate-session concurrency proofs passed. In the new
  proof, activation wins before competing withdrawal, which waits and refuses;
  then withdrawal of an unbound target wins before competing replacement, which
  waits and refuses. Exact final binding, role, registration and Access state are
  checked after both real-writer orders.
- Lint across all five schemas reported no errors. The same three existing
  warnings remain: two unused variables in the now-renamed private application
  coordinator and a text-to-UUID initialization in the platform-catalogue helper.
- The focused contract and test-only handoff checks passed all 31 tests, including
  exact operation, organisation, binding, revision, actor and correlation pairing.
- The full repository gate passed: 1,165 tests with three existing skips, 78
  passing test files with two skipped files, all eight fixtures, and all 23 package
  typechecks, builds and boundary checks, plus formatting and lint.

Independent Sol review compared the complete frozen implementation and proofs
against D2's acceptance criteria and approved them without a remaining finding.

Source review corrected the new nullable-tuple check and the SQL time expression
before any persistent application. A later focused test used the wrong existing
assignment-operation spelling; correcting that fixture made the full suite pass.
No additional state mechanism was needed. Rollback-only probes also verified all
55 original D1 assertions before the additive local migration was applied.

SQL fixtures roll back; concurrency cleanup checks its unique owned fixture.
The SQL and concurrency suites ran sequentially on the shared database. This
evidence does not claim a hosted receipt, production delivery or a usable interface.

## Frozen database artifacts

- `20260906033309_coordinate_organization_management_application_requirement.sql`:
  `3d840ef1c5a79071025f79371a90f1030e73a87aff6bbc46703c3c01eb41c12e`
- `270_organization_management_application_requirement.test.sql`:
  `c678830c2da101fa947305537088ed1028b43042ba44fc8a8a8656a108a92d66`
- `organization-management-application-concurrency.test.sh`:
  `4d9fd87436af5a65b8bf1131b2c0c52a2bd09414774efb7a3aed296940ae3c52`
- `workflows/kestra/database-verification.json`:
  `24adb0f392fdbda097ae15d48c14a71d5b89535415c4bcfad4f6c27be839ef09`
