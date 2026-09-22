# Historical ownership and lifecycle resolution — 12 September 2026

This historical packet is superseded by the [21 September architecture review](architecture-review-2026-09-21.md), [current roadmap](README.md) and current issue descriptions. It supplies no pickup order, worker assignment, completion gate or operational authorization. Development completion is implementation plus independent code review; no tests, database review, hosted proof or legacy-format compatibility work is required.

Approved decisions remain in [record ownership and lifecycle](../specification/appendices/record-ownership-and-lifecycle.md): account ownership derives from the creator; initial Group ownership requires current membership; account archival and record transfer include retained records and disabled installations; organisation ceilings constrain record-type lifecycle policy.

Time-dependent calculations refresh when due, including before filtering/sorting/pagination, and automatic deadline work refreshes without a user save. Privacy removal respects holds and archival destinations. Recovery retains surviving erasure/revocation information to prevent resurrection. Support access is scoped, expiring, attributed and read-only. Current issues own these capabilities in their scheduled phases.
