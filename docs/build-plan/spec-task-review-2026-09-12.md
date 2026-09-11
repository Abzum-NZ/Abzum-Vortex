# Specification and task review — 12 September 2026

## Scope and evidence

Inventoried all **183 repository issues** (open and closed), **190 project items**
and native blocked-by/sub-issue relationships. Semantic review covered the
specification chapters, supporting appendices, and related task/plan ownership;
the issue-body review concentrated on current and cross-phase integration work.
This is not a claim of line-by-line semantic verification of every historical
issue comment or every plan revision. Three independent
GPT-6 Astra review passes covered product contracts, supporting/runtime services,
and the board/plan. The coordinator reconciled findings and corrected the
documentation-only items identified below.

Sources: [roadmap](https://github.com/orgs/Abzum-NZ/projects/2/views/3),
[main baseline](https://github.com/Abzum-NZ/Abzum-Vortex/tree/70fc389687adfcf29dec775aef301fb1d0f8fca3),
[newer Testing baseline](https://github.com/Abzum-NZ/Abzum-Vortex/tree/b74abb9cba2d44628c25e77fca4afca1ae573657).
Testing corrections were checked before reporting defects. In particular, the
request-context repair and completed field-access work are not missing work.
This is a requirements/delivery review with targeted contract inspection, not a
new full-code security audit or a claim that unexecuted application journeys pass.

No open issue is missing from the project, no issue-state/Done mismatch was found,
and the native dependency graph has no cycle. Native phase membership and prose
can nevertheless be wrong. Initial completion was **66/190 (34.7%)**; adding the
review task changes the denominator. No runtime, database or deployment changed.

## Resolution status — 12 September 2026

The historical findings below are reconciled in the [resolution and delivery map](ownership-lifecycle-review-resolution.md). Both product choices are approved and removed from the register. Corrected task bodies and native dependencies retain implementation ownership; #407/#408/#409 cover new/missing delivery. Documentation review and merge are tracked in [PR #406](https://github.com/Abzum-NZ/Abzum-Vortex/pull/406). This resolves requirements, not the future implementation tasks.

## Historical findings and smallest corrective action

P1 means resolve before the affected implementation; P2 means a required scoped
correction or later delivery gap. Neither creates a project-wide approval hold.

| ID | Priority / finding | Evidence and impact | Owner / smallest correction |
| --- | --- | --- | --- |
| R01 | P1 — Ambiguous organisation URLs | [People](../specification/02-people-organisations-and-sign-in.md) permits the same organisation short name in different tenants; [application routes](../specification/07-applications-pages-and-themes.md#addresses-and-routing) omit tenant identity. An identity may belong to both organisations. | [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64): choose tenant-qualified or permanent-organisation-ID routes without changing tenant-local uniqueness. Prove two matching short names resolve separately, including reserved paths. Engineering decision, not another global-name registry. |
| R02 | P1 — Application-contained data definitions lack an engine contract | [Page-builder contracts](../specification/appendices/page-builder-contracts.md) calls contained definitions an existing capability. [#52](https://github.com/Abzum-NZ/Abzum-Vortex/issues/52)/[#251](https://github.com/Abzum-NZ/Abzum-Vortex/issues/251) require them, but Application contracts bind independently published Modules; application-contained row scope does not make the Module definition owned/versioned by its Application. | Reconcile with [composition](../specification/03-composition-and-publication.md) in [#43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43)/[#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64) before UI. Prefer ordinary bound Modules if they meet the intended behaviour; otherwise explicitly own compilation, publication, storage and upgrade semantics. Do not invent a third publication root or make UI create an absent engine. |
| R03 | P1 — Contradictory save-refusal outcomes | The current corrected acceptance in [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47) requires no Activity effect for forbidden submitted fields and later requires a separate refused Activity entry. It also needs a consistent safe error shape. | Reconcile with [#41](https://github.com/Abzum-NZ/Abzum-Vortex/issues/41): no successful record/event/receipt effects; explicitly allow only the intended content-free refusal evidence, if that is the owning rule. Test rollback and safe diagnostic behaviour once. |
| R04 | P1 — Two existing product questions absent from the register | Current [#402](https://github.com/Abzum-NZ/Abzum-Vortex/issues/402) asks who owns a newly created account/Group-owned record; [#48](https://github.com/Abzum-NZ/Abzum-Vortex/issues/48) asks whether time-dependent calculations must be current during reads/filtering/sorting. The register said no questions remained. | **Register corrected** with options/recommendations in [decisions](../specification/appendices/decisions.md). Resolve only these behaviours; unrelated storage and non-time-dependent totals can proceed. |
| R05 | P1 — Lost-project restore can lose later erasure/revocation evidence | [Privacy](../specification/14-activity-privacy-and-retention.md) and [recovery](../specification/19-operations-backup-and-recovery.md) require post-backup removal/revocation replay. A 10:00 backup, 10:30 erasure and 10:45 source-project loss has no specified surviving 10:30 evidence. Meeting one-hour RPO alone does not prevent resurrection. | [#170](https://github.com/Abzum-NZ/Abzum-Vortex/issues/170), consuming [#116](https://github.com/Abzum-NZ/Abzum-Vortex/issues/116)/[#117](https://github.com/Abzum-NZ/Abzum-Vortex/issues/117)/[#153](https://github.com/Abzum-NZ/Abzum-Vortex/issues/153): define surviving evidence/completeness and test this case. Keep affected data/access unavailable if completeness cannot be established. Later recovery work only; do not reopen deferred Kestra work. |
| R06 | P2 — File/Storage identity handoff unspecified | [Files](../specification/11-files-and-attachments.md) promises independent Storage RLS and File checks. The transaction-bound Vortex context does not automatically accompany Storage HTTP requests, particularly when Identity Authority and data cluster differ. [Runtime](../specification/17-runtime-storage-and-caching.md) excludes broad service-role access. | [#92](https://github.com/Abzum-NZ/Abzum-Vortex/issues/92), consumed by [#93](https://github.com/Abzum-NZ/Abzum-Vortex/issues/93)/[#156](https://github.com/Abzum-NZ/Abzum-Vortex/issues/156): specify a supported destination credential/scope bridge and prove local, remote and system operations. A broad server key is not independent RLS proof. [Official Storage guidance](https://supabase.com/docs/guides/storage/security/access-control). |
| R07 | P2 — Support impersonation has no implementation owner | [Operations](../specification/19-operations-backup-and-recovery.md) promises read-only, expiring, attributed support access, with approval “where feasible”. [#119](https://github.com/Abzum-NZ/Abzum-Vortex/issues/119)/[#173](https://github.com/Abzum-NZ/Abzum-Vortex/issues/173) only describe runbooks/support boundaries; [#322](https://github.com/Abzum-NZ/Abzum-Vortex/issues/322) excludes general impersonation. | Assign bounded Phase 13 delivery using existing Access/Activity: whose rights are evaluated, operator/subject attribution, approval/exception authority, expiry and revocation. Ticket edits must not grant access. No new impersonation engine in the frontend-flow task. |
| R08 | P2 — Cross-module delete setting exists only in task text | Active [#49](https://github.com/Abzum-NZ/Abzum-Vortex/issues/49) requires a child-record-type inbound-delete opt-in, default off. [Relationship spec](../specification/05-modules-fields-and-relationships.md) and strict record-type contracts only describe relationship/dependent-ownership deletion. | Correct #49 to approved semantics or explicitly specify the additional policy before implementation. Retain actual child access and atomic deletion checks; do not invent an undeclared switch. |
| R09 | P2 — Definition-history metadata promise differs from contract | [Page contracts](../specification/appendices/page-builder-contracts.md) and [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249) require history to expose source and validation format versions. [Data contracts](../specification/appendices/data-contracts.md) and the strict history metadata schema omit them. | #249 decides whether public metadata is useful; either add it with tests or remove the unnecessary promise while retaining internal restore-version verification. Do not claim this acceptance is already delivered. |
| R10 | P2 — Task prose and roadmap status contradict delivered work | Closed [#35](https://github.com/Abzum-NZ/Abzum-Vortex/issues/35) still says no database decision exists. Project README describes old holds and undelivered [#37](https://github.com/Abzum-NZ/Abzum-Vortex/issues/37). Current handoff files point to completed assignments. | **Repository plan summaries corrected** and old handoffs labelled historical. Still clean current #35 body/project README from verified evidence without erasing historical receipts or changing real task states. A Done neutral engine is not a working whole application. |
| R11 | P2 — Required tasks omitted from native phase hierarchy | Twelve open non-epics have no native parent: [#271](https://github.com/Abzum-NZ/Abzum-Vortex/issues/271), [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327), [#376](https://github.com/Abzum-NZ/Abzum-Vortex/issues/376), [#377](https://github.com/Abzum-NZ/Abzum-Vortex/issues/377), [#378](https://github.com/Abzum-NZ/Abzum-Vortex/issues/378), [#379](https://github.com/Abzum-NZ/Abzum-Vortex/issues/379), [#390](https://github.com/Abzum-NZ/Abzum-Vortex/issues/390), [#395](https://github.com/Abzum-NZ/Abzum-Vortex/issues/395), [#396](https://github.com/Abzum-NZ/Abzum-Vortex/issues/396), [#399](https://github.com/Abzum-NZ/Abzum-Vortex/issues/399), [#400](https://github.com/Abzum-NZ/Abzum-Vortex/issues/400), [#404](https://github.com/Abzum-NZ/Abzum-Vortex/issues/404). | Attach actual phase deliverables, especially Landing Zone, first-app proof, transactional Event and moved upgrade acceptance, to their owning epic. Document intentional standalone maintenance/bugs. Do not add broad blocking dependencies merely to make the hierarchy complete. |
| R12 | P2 — Cross-phase acceptance points to wrong consumer or is empty | [#76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76)/[#99](https://github.com/Abzum-NZ/Abzum-Vortex/issues/99)/[#102](https://github.com/Abzum-NZ/Abzum-Vortex/issues/102) say the first-app proof consumes execution that [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327) explicitly defers. [#107](https://github.com/Abzum-NZ/Abzum-Vortex/issues/107) has an empty page-integration checkbox. [#108](https://github.com/Abzum-NZ/Abzum-Vortex/issues/108) still describes a temporary entitlement fallback. | Point full cross-phase proof to [#254](https://github.com/Abzum-NZ/Abzum-Vortex/issues/254); fill public-page filtered-projection acceptance in #107; align #108 with [#118](https://github.com/Abzum-NZ/Abzum-Vortex/issues/118). Preserve the engines-before-designer sequence. |
| R13 | P2 — Duplicated requirements are producing conflicting owners | The same long configurable-flow paragraphs appear in 19 task bodies, alongside old and new acceptance lists. The errors above show actual maintenance cost, not merely long documents. | Link one normative flow section and keep each task's own inputs, outputs and acceptance. Replace obsolete active prose rather than appending another correction layer. No new tracker or review framework. |
| R14 | P2 — Publication veto contradicts pinned releases | Chapter 05 forbade removal whenever external dependants exist; chapter 03 permits inert breaking publication with old consumers pinned. | **Specification corrected:** candidate-internal dangling references and incompatible adoption refuse; external pinned consumers do not veto publication. Existing [#43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43)/[#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64)/[#404](https://github.com/Abzum-NZ/Abzum-Vortex/issues/404) own adoption. |
| R15 | P2 — Governance wording creates unnecessary global holds and busywork | Specification authority required an empty register and sent every conflict to it; change rules required all documents to change. That conflicts with affected-work-only holds and engineering ownership. | **Corrected:** approved requirements stay valid; only affected business behaviour waits. Engineering findings belong to tasks. Check all impacts, edit only affected documents. |
| R16 | P3 — Broken reference and wrong Query owner | Chapter 08 linked a missing Event plan; chapter 07 and data contracts assigned Query receipts to system-actions [#50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50). Root README pinned an old spec version. | **Corrected:** link [Event #60](https://github.com/Abzum-NZ/Abzum-Vortex/issues/60), [Query #54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54), and the current specification index. |

## Completion criteria for the findings task

- Each unresolved row has an explicit owning task and corrected acceptance, or a
  reasoned dismissal with evidence. Reuse existing tasks; create a child only for
  genuinely missing delivery, such as support access.
- Resolve R01–R04 before implementing their affected behaviour. Record the two
  business answers in permanent requirements and clear them from the register.
- Reconcile native phase membership and current project/task prose without
  reopening completed foundations or declaring Testing changes Production-ready.
- Keep later recovery/File/support work in its actual phase; no new global hold.
- Verify changed docs/references and independently review corrections. Do not
  close this findings task merely because this review or its documentation PR is
  complete; unresolved rows remain work.

## Not findings

- Unbuilt later features with clear owners are not automatically missing scope.
- Existing Access revisions/transactions/continuity protections must not be
  removed just because their explanation is lengthy. No concrete failure proof
  justified weakening those mechanisms in this review.
- The current MCP transport reference was checked against the
  [official specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http);
  it is not flagged as outdated. Closed historical assistant tasks are not active
  embedded-model requirements.
- Current cache ownership is already with the Query consumer. No new cache
  framework, backup programme or Kestra upgrade is recommended.
