# Open decision register

[Specification index](../README.md) · [Data contracts](data-contracts.md) · [Build plan](../../build-plan/README.md)

There is one open, non-blocking authoring-interface decision. The underlying rule/action contracts, pure preview, authoritative server evaluation, and post-commit durable-work hand-off are settled and may proceed.

The choices formerly numbered D01–D37 have been incorporated into the permanent requirements, contracts, examples, acceptance tests, build phases, and linked GitHub work. They are intentionally absent here so implementation cannot mistake a resolved option for an open question.

Credentials, service access, environment health, one-time deployment or destructive-operation approval, and implementation findings are not product decisions. Track them in the responsible delivery issue or runbook, with their owner and evidence. Add them here only if two viable answers would materially change a permanent product requirement or architecture.

The September architecture review resolved the HR example scope, workflow-based manager approval with HR fallback, and no self-approval. The permanent requirements are in [HR example policy](page-builder-contracts.md#hr-example-policy); implementation gaps remain in delivery tasks, not in this decision register.

The 5 September Roles and Groups clarification and optional per-role PIM model are incorporated in [Groups and privileged access](groups-and-privileged-access.md) and their owning tasks. Organisation policy configuration (duration, authentication and required review) is not an unresolved universal product setting. There is no new open decision from that clarification.

## D38 — Immediate behaviour authoring surface

**Question:** Should Studio author immediate rules and synchronous actions through one shared pure declarative rule/action designer, or introduce a separate front-end interaction designer in addition to the authoritative rule/action editor?

**Options:**

1. **Shared pure declarative rule/action designer (recommended).** The same published typed definitions drive immediate browser preview and authoritative server execution. Studio may present context-specific panels, but it does not create a second rule language or a front-end-only behaviour artifact. This minimises semantic drift and makes the transaction-versus-background boundary explicit.
2. **Separate front-end interaction designer.** A distinct authoring surface may improve presentation-focused editing, but it must compile to the same published rule/action contracts and cannot add client-only authority, arbitrary expressions, or another execution language. It adds mapping, migration, parity, and testing cost.

This choice concerns only the Studio authoring experience. It does not reopen the confirmed behaviour: preview is pure; Vortex rechecks current authority and typed published inputs; a successful save commits its durable event or start fact with the record; post-commit dispatch is duplicate-safe; and Kestra never runs from a rejected or rolled-back save. It is also separate from the durable workflow graph designer.

**Affected work:** final Studio authoring interaction in [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) and its implementation hand-off [#65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65). It does not block the headless page contracts [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249), rule evaluator [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58), immediate feedback [#59](https://github.com/Abzum-NZ/Abzum-Vortex/issues/59), or protected workflow hand-off [#76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76) and [#77](https://github.com/Abzum-NZ/Abzum-Vortex/issues/77).

**Decision owner and review point:** Vijay, 5 September 2026, before the final #64/#65 Studio authoring surface is accepted.

## Adding an open decision

Add an entry only when different reasonable answers would materially change product behaviour, data ownership, security, protected data handling, entitlements, delivery, or build order. Each entry must state:

- The plain-language question.
- The viable options and their consequences.
- The recommended option, if one is supportable.
- The specification, contract, build-plan, and GitHub work that remain blocked.
- The named decision owner and review date.

Once decided, update every affected permanent document and GitHub task, add or revise acceptance evidence, and remove the entry in the same change.
