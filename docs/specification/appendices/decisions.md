# Open decision register

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Build plan](../../build-plan/README.md)

There are no open user decisions. The selected [Frontend Rule Designer](frontend-rule-designer.md) now includes shared conditions, flow variables, extensible nodes, configurable read/write component flows, per-node Current user/Specified user/System execution, managed-flow controls and reusable forms. Collect-first atomic submission is optional; sequential protected commits have explicit partial outcomes. Implementation gaps are tracked in its [delivery plan](../../build-plan/frontend-rule-designer.md), not held for another product approval.

Resolved choices have been incorporated into the permanent requirements, contracts, examples, acceptance tests, build phases, and linked GitHub work. They are intentionally absent here so implementation cannot mistake a resolved option for an open question.

Credentials, service access, environment health, one-time deployment or destructive-operation approval, and implementation findings are not product decisions. Track them in the responsible delivery issue or runbook, with their owner and evidence. Add them here only if two viable answers would materially change a permanent product requirement or architecture.

The user approved removal-only cleanup of assignments to withdrawn roles/permissions
on 8 September 2026. The permanent limits and verification requirements are in
[access administration #40](../../build-plan/issue-40-protected-access-administration.md#approved-removal-only-cleanup-after-withdrawal--8-september-2026);
that authorization is resolved and is not an open decision. Implementation and
delivery evidence remain in the responsible task. The separate
[#35 tool-execution restriction](../../build-plan/issue-35-row-policy-composition.md#narrow-implementation-authorization--8-september-2026)
is unaffected by this approval and is not a product decision.

The September architecture review resolved the HR example scope, workflow-based manager approval with HR fallback, and no self-approval. The permanent requirements are in [HR example policy](page-builder-contracts.md#hr-example-policy); implementation gaps remain in delivery tasks, not in this decision register.

The 5 September Roles and Groups clarification and optional per-role PIM model are incorporated in [Groups and privileged access](groups-and-privileged-access.md) and their owning tasks. Organisation policy configuration (duration, authentication and required review) is not an unresolved universal product setting. There is no new open decision from that clarification.

## Adding an open decision

Add an entry only when different reasonable answers would materially change product behaviour, data ownership, security, protected data handling, entitlements, delivery, or build order. Each entry must state:

- The plain-language question.
- The viable options and their consequences.
- The recommended option, if one is supportable.
- The specification, contract, build-plan, and GitHub work that remain blocked.
- The named decision owner and review date.

Once decided, update every affected permanent document and GitHub task, add or revise acceptance evidence, and remove the entry in the same change.
