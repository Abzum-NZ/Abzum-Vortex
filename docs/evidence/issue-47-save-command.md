# Protected base Record save — delivery evidence

[Task #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) ·
[Implementation plan](../build-plan/issue-47-save-command.md) ·
[Record specification](../specification/06-records-and-lifecycle.md) ·
[Save contract](../specification/appendices/data-contracts.md#record-save-command-and-result)

## Delivered base

The delivered #47 base adds one strict ordinary-human create/update service,
one server-only preparation operation, one fixed terminal writer, and a private
command receipt. It composes the already delivered Record, Activity and Event
owners without exposing their primitives.

Create may select one currently eligible owner Group. Update retains its existing
owner and requires the last observed concurrency number. Both operations derive
scope, actor, exact installed definition and permissions from the verified
request. Private preparation values never become a public projection.

The terminal transaction commits the Record/fixed relationship changes, success
Activity, required standard Event, queue message and receipt together. A verified
clean update denial records one organisation-only Activity; invalid, stale and
unverified requests do not. Exact retry reprojects through current Access before
returning and cannot repeat effects or disclose withdrawn values.

Unused named-action or custom-Event declarations do not disable ordinary saves.
Actual immediate Rules, named action execution, broader
relationship shapes, System execution and Event delivery consumers retain their
linked owners in the [implementation plan](../build-plan/issue-47-save-command.md#supported-now-and-later-owners).
Subsequent #48 stages 1–2B integrated calculations and relationship totals;
deadline-driven recalculation remains that issue's next stage.

## Local verification

The original review handoff required the following local evidence:

| Proof | Required result |
| --- | --- |
| Clean local migration reset | Full ordered migration chain applies. |
| Focused Record database test | Base save, ACL, refusal, retry, relationships and forced rollback pass. |
| Compiler-backed PostgreSQL integration | Real public service create/update/retry/conflict/current projection passes over a restricted runtime connection. |
| Record runtime tests | Public mapping, hidden-field containment and no duplicate terminal refusal pass. |
| Two-session proof | One same-revision save wins, one returns stale conflict, and only one effect set remains. |
| Full database/type/lint/format checks | No regression in the delivered foundations. |

## Hosted acceptance

The [closure receipt](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47#issuecomment-5656036501)
records independent source/review approval and successful hosted Testing
execution `5cV5qDGWTAGj220A35kmE` for revision
`f93c8d60d02e60fa7b8cd10a951632766f826ffc`: 95 migrations, 80 SQL files,
3,865 assertions, 30 selected concurrency proofs and 10 selected lint schemas.
It covers PR #435 and ordered-delivery/fixture repairs through #443.

The 14 September planning reconciliation confirmed that accepted revision is
an ancestor of Testing `b0a630045ccadba6697f94c853b8573ecc00f76d`.
This reconciliation inspected the existing receipt and source; it did not rerun
hosted tests or claim that every later Testing change has passed. #47 remains
closed/Done. No Production readiness is claimed.
