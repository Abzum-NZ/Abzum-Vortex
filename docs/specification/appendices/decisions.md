# Open decision register

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Build plan](../../build-plan/README.md)

## Open choices — authority ledgers, 25 September 2026

The [authority-ledger design record](../../build-plan/authority-ledgers-design-2026-09-25.md#0-decisions-for-the-owner-coordinator-please-relay) asks four questions. Its recommendations are proposals, not owner approvals. Until the owner decides, the current [Access specification](../04-access-and-permissions.md) and [Architecture Decision 11](../../build-plan/architecture-decisions-2026-09-25.md#decision-11--building-installing-and-system-applications-are-permission-gated) govern implementation.

| Question for the product owner | Options and consequence | Recommendation and affected work |
| --- | --- | --- |
| Q1: Should delegation move from `organization_delegation_authorities` to a separate scope carried by management roles? | A role-carried scope changes authority for every holder when the role changes; the current ledger grants and replaces scope per holder. | Adopt only with separate acceptance for delegation and use, a direct non-expiring steward catalogue scope, and all [B1 safeguards](../../build-plan/authority-ledgers-design-2026-09-25.md#52-removable-only-if-the-owner-agrees-each-changes-a-merged-specification). Spec 04 and the delegation writers/readers would change. |
| Q2: Should tenant powers move to tenant-scoped ordinary roles in one assignment ledger? | This changes the current separate tenant-authority model, adds tenant scope to assignments and must preserve subset, expiry, self-grant and permanent-manager checks. | Keep the seven-key tenant ledger for now. A different answer changes [spec 04](../04-access-and-permissions.md) and its tenant grant path. |
| Q3: Should privileged activation become a time-bounded standing assignment created by a flow? | A bare assignment loses eligibility-without-use, self-activation/deactivation, membership pinning and continuity; rebuilding those checks recreates an activation ledger. | Keep activations under [the privileged-access contract](groups-and-privileged-access.md). A different answer changes that contract and #1052. |
| Q4: Should the 13-permission permanent-steward set move from SQL to catalogue data? | Catalogue data could define the set, but a release must refuse empty or silently reduced protection. | Optional; preserve the current safeguard until the owner accepts a catalogue-release rule. |

The owner previously approved creator/current-membership Group ownership and automatic deadline refresh. Permanent requirements, including account transfer and record lifecycle limits, are in [record ownership and lifecycle](record-ownership-and-lifecycle.md). Delivery gaps remain on the GitHub tasks, not here.

Resolved choices have been incorporated into the permanent requirements, contracts, examples, build phases and linked GitHub work. They are intentionally absent here so implementation cannot mistake a resolved option for an open question.

Credentials, service access, environment health, one-time deployment or destructive-operation approval, and implementation findings are not product decisions. Track them in the responsible delivery issue or runbook, with their owner and evidence. Add them here only if two viable answers would materially change a permanent product requirement or architecture.

The September architecture review resolved the HR example scope, workflow-based manager approval with HR fallback, and no self-approval. The permanent requirements are in [HR example policy](page-builder-contracts.md#hr-example-policy); implementation gaps remain in delivery tasks, not in this decision register.

The 5 September Roles and Groups clarification and optional per-role PIM model are incorporated in [Groups and privileged access](groups-and-privileged-access.md) and their owning tasks. Organisation policy configuration (duration, authentication and required review) is not an unresolved universal product setting. There is no new open decision from that clarification.

The owner resolved the named Vortex super-administrator entry choice on 27
September 2026: local organisation accounts remain the sole entry path. An active
named super administrator selecting an eligible organisation without an account
receives a provisioned local account with assignment provenance and Activity
evidence; a suspended account is refused without reactivation. Person-backed
ceiling commands and reactivation belong to #1441. The configured system operator
remains the sole caller for the #1384 entitlement authority. See [people and
sign-in](../02-people-organisations-and-sign-in.md#named-vortex-super-administrators)
and [access and permissions](../04-access-and-permissions.md#named-vortex-super-administrators).

## Adding an open decision

Add an entry only when a genuinely unresolved business/product choice needs the owner's decision. Engineering, security, database, implementation and dependency decisions belong to the responsible task and its engineering review, even when their impact is material. Hold only the affected work, and continue independent work. Each business-decision entry must state:

- The plain-language question.
- The viable options and their consequences.
- The recommended option, if one is supportable.
- The specification, contract, build-plan, and GitHub work that remain blocked.
- The named decision owner and review date.

Once decided, update every affected permanent document and GitHub task, add or revise acceptance evidence, and remove the entry in the same change.
