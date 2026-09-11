# Open decision register

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Build plan](../../build-plan/README.md)

Two product questions already recorded in GitHub on 12 September 2026 remain open below. The selected [Frontend Rule Designer](frontend-rule-designer.md) includes shared conditions, flow variables, extensible nodes, configurable read/write component flows, per-node Current user/Specified user/System execution, managed-flow controls and reusable forms. Those settled choices are not reopened.

## Open choices — reviewed 12 September 2026

| Question and owner | Options and recommendation | Affected work only |
| --- | --- | --- |
| Initial record owner — Vijay | A: account-owned records default to their creator; Group-owned records require a selected current membership Group, as proposed in the task. B: the application explicitly configures the initial owner, restricted by separately enforced create/assignment authority. Recommend B with creator/current-Group defaults: it supports delegated creation without making an arbitrary submitted owner authoritative. | [Create adapters #402](https://github.com/Abzum-NZ/Abzum-Vortex/issues/402), [record lifecycle](../06-records-and-lifecycle.md), ownership input and its positive/refusal tests. Other storage work may continue. |
| Time-dependent calculated values — Vijay | A: stored calculations remain save-time snapshots, with clearly separate current-time query expressions when needed. B: reads, filters and sorts must always evaluate time-dependent calculations at the current request time. Recommend A for the first release, explicitly labelled; B needs consistent query evaluation, not a background refresh that can still be stale. | [Calculations #48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48), [Query #54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54), calculated-field semantics and freshness tests. Non-time-dependent totals may continue. |

Resolved choices have been incorporated into the permanent requirements, contracts, examples, acceptance tests, build phases, and linked GitHub work. They are intentionally absent here so implementation cannot mistake a resolved option for an open question.

Credentials, service access, environment health, one-time deployment or destructive-operation approval, and implementation findings are not product decisions. Track them in the responsible delivery issue or runbook, with their owner and evidence. Add them here only if two viable answers would materially change a permanent product requirement or architecture.

The September architecture review resolved the HR example scope, workflow-based manager approval with HR fallback, and no self-approval. The permanent requirements are in [HR example policy](page-builder-contracts.md#hr-example-policy); implementation gaps remain in delivery tasks, not in this decision register.

The 5 September Roles and Groups clarification and optional per-role PIM model are incorporated in [Groups and privileged access](groups-and-privileged-access.md) and their owning tasks. Organisation policy configuration (duration, authentication and required review) is not an unresolved universal product setting. There is no new open decision from that clarification.

## Adding an open decision

Add an entry only when a genuinely unresolved business/product choice needs the owner's decision. Engineering, security, database, implementation and dependency decisions belong to the responsible task and its engineering review, even when their impact is material. Hold only the affected work, and continue independent work. Each business-decision entry must state:

- The plain-language question.
- The viable options and their consequences.
- The recommended option, if one is supportable.
- The specification, contract, build-plan, and GitHub work that remain blocked.
- The named decision owner and review date.

Once decided, update every affected permanent document and GitHub task, add or revise acceptance evidence, and remove the entry in the same change.
