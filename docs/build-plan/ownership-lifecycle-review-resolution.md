# Ownership, lifecycle and review corrections — 12 September 2026

[Specification](../specification/appendices/record-ownership-and-lifecycle.md) · [Findings #405](https://github.com/Abzum-NZ/Abzum-Vortex/issues/405) · [Roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3)

These are approved requirements and implementation ownership, not delivered runtime behaviour. The decision register is clear.

| Pickup order | Task | Functional outcome and dependencies |
| --- | --- | --- |
| 2 — Modules and saving | [#402](https://github.com/Abzum-NZ/Abzum-Vortex/issues/402) | Initial owner is creator/current-membership Group; follows fixed adapters #401. |
| 3 — Records complete | [#407](https://github.com/Abzum-NZ/Abzum-Vortex/issues/407) | Archive account, transfer by application and prevent deletion while records remain. Follows #402/#50/#30; includes disabled installations and retained records. |
| 3 — Records complete | [#408](https://github.com/Abzum-NZ/Abzum-Vortex/issues/408) | Organisation ceilings and record-type lifecycle policies. Follows #43/#30; #64 activation and #117 execution consume it. |
| 2 — Modules and saving | [#48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) | Stored calculations and transitive totals, plus next-deadline refresh operation after #47. |
| 4 — Reading foundations | [#54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54) | Query freshness uses #48 for due calculations and dependent totals, including filtering before pagination. |
| 4 — Reading foundations | [#62](https://github.com/Abzum-NZ/Abzum-Vortex/issues/62) | Bounded automatic deadline refresh, rescheduling and catch-up; consumes #48/#54 and existing event scheduling. |
| 6 — First definition-led app | [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327) | Proves no-save deadline behaviour using #62 as well as its existing engine dependencies; visual designer remains later. |
| 6 — First definition-led app | [#72](https://github.com/Abzum-NZ/Abzum-Vortex/issues/72) | Ordinary administration forms expose transfer and policy operations; depends on #407/#408, not vice versa. |
| 12 — Privacy and retention | [#117](https://github.com/Abzum-NZ/Abzum-Vortex/issues/117) | Uses #408 age/count policies, holds and existing removal engine. Workflow archival requires registered Workflow/Connection capabilities and verified destination before deletion. |
| 13 — Operations | [#409](https://github.com/Abzum-NZ/Abzum-Vortex/issues/409) | Approved read-only support with current restricted access; follows #119/#34/#41/#93/#276 and precedes #173 readiness. |
| 13 — Operations | [#170](https://github.com/Abzum-NZ/Abzum-Vortex/issues/170) | Surviving removal evidence prevents restore resurrecting erased data/access. No new immediate Kestra maintenance scope. |

Native dependencies, not phase numbers alone, decide readiness. Definitions may be prepared before optional later action capabilities exist; enabling an action requires its actual engine. Avoid reversing consumer dependencies into foundational tasks.

## Review dispositions

- R01–R02: tenant-qualified routes and independently versioned bound Modules; no third publication root. Owners #64/#52/#251.
- R03: #47 now uses one #41 clean pre-write request refusal in the owning transaction, distinct from successful effects and safe readable-field corrections.
- R04: approved ownership and deadline decisions incorporated; no remaining user hold.
- R05–R07: later recovery/File identity/support delivery has exact contracts and owners #170/#92/#93/#156/#409.
- R08–R09: remove invented inbound-delete opt-in and public history-format metadata promise; keep current access and internal restore verification.
- R10: #35 describes its delivered database scope; roadmap replaces stale implementation/approval claims.
- R11: eleven previously parentless delivery issues now have native phase parents. #390 remains an explicitly standalone test-performance regression, not a reason to reopen completed Phase 1.
- R12: full cross-phase integration is #254, not first-app #327; #107 has concrete public projection acceptance; #108 consumes #118.
- R13: repeated flow semantics replaced by one normative link with local acceptance retained; superseded #47/#48 bodies removed.
- R14–R16: pinned-release publication, affected-work-only decisions and broken/wrong references corrected in the prior review commit.

Implementation work remains open in its own tasks. Closing the review's requirements reconciliation does not close future runtime delivery.
