# Protected base Record save — local evidence

[Task #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) ·
[Implementation plan](../build-plan/issue-47-save-command.md) ·
[Record specification](../specification/06-records-and-lifecycle.md) ·
[Save contract](../specification/appendices/data-contracts.md#record-save-command-and-result)

## Candidate implementation under review

The local #47 candidate adds one strict ordinary-human create/update service,
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
Actual immediate Rules, calculations/totals, named action execution, broader
relationship shapes, System execution and Event delivery consumers retain their
linked owners in the [implementation plan](../build-plan/issue-47-save-command.md#supported-now-and-later-owners).

## Local verification

The candidate must retain exact command output in the review handoff rather than
freezing unverifiable hashes before review. Current required evidence is:

| Proof | Required result |
| --- | --- |
| Clean local migration reset | Full ordered migration chain applies. |
| Focused Record database test | Base save, ACL, refusal, retry, relationships and forced rollback pass. |
| Compiler-backed PostgreSQL integration | Real public service create/update/retry/conflict/current projection passes over a restricted runtime connection. |
| Record runtime tests | Public mapping, hidden-field containment and no duplicate terminal refusal pass. |
| Two-session proof | One same-revision save wins, one returns stale conflict, and only one effect set remains. |
| Full database/type/lint/format checks | No regression in the delivered foundations. |

This evidence remains local and provisional until an independent GPT-6 Astra
review approves the exact patch and the same revision passes hosted Testing.
No merge, deployment or production change is claimed here.
