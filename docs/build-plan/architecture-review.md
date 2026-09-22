# Historical architecture review

This historical packet is superseded by the [21 September architecture review](architecture-review-2026-09-21.md), [current roadmap](README.md) and current issue descriptions. It supplies no pickup order, worker assignment, completion gate or operational authorization. Development completion is implementation plus independent code review; no tests, database review, hosted proof or legacy-format compatibility work is required.

The earlier review examined service ownership, Definition compilation/publication, identity/session boundaries and Fluid editor reuse. Current source findings and implementation ownership are consolidated into the new architecture review.

Preserved decisions: business semantics belong in definitions; protected operations retain tenant and field access; page authoring uses declared slots and stable identities; editor-private state is not the application representation. See [page-builder contracts](../specification/appendices/page-builder-contracts.md), [Fluid integration](fluid-integration-map.md) and the [core boundary](../specification/appendices/core-contract-boundary.md).
