# Historical specification/task review — 12 September 2026

This historical packet is superseded by the [21 September architecture review](architecture-review-2026-09-21.md), [current roadmap](README.md) and current issue descriptions. It supplies no pickup order, worker assignment, completion gate or operational authorization. Development completion is implementation plus independent code review; no tests, database review, hosted proof or legacy-format compatibility work is required.

Resolutions are consolidated into current issues and these specifications:

- [Applications](../specification/07-applications-pages-and-themes.md): tenant-qualified routes and independently versioned bound Modules; no third publication root.
- [Records](../specification/06-records-and-lifecycle.md): atomic save effects and separate safe refusal activity; relationship deletion follows declared semantics and current child authority, without an invented opt-in.
- [Files](../specification/11-files-and-attachments.md): destination credentials/context enforce file access for human and system callers.
- [Composition](../specification/03-composition-and-publication.md): inert breaking publication does not move pinned consumers; incompatible adoption is refused.
- [Recovery](../specification/19-operations-backup-and-recovery.md): surviving erasure/revocation records prevent resurrection; incomplete recovery keeps affected content unavailable.
- [Ownership and lifecycle](../specification/appendices/record-ownership-and-lifecycle.md): ownership, transfer, policy and deadline behaviour.

The old cross-phase proof task is cancelled. Later workflow, sharing, interface and sample-application functionality retains explicit implementation owners. Only unresolved product decisions affecting a feature delay that feature.
