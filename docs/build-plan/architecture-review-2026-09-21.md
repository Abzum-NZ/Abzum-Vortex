# Architecture review — 21 September 2026

Vortex needs a connected application runtime more than another foundation or verification programme. Main already contains substantial Definition, Identity, Access, Module and Record implementation. Query, App, the shared UI renderer and several later services are still placeholders. The revised roadmap connects the existing foundations to a real, definition-led application by the end of Phase 6, then adds designers and the remaining platform capabilities.

## Review baseline and method

The source baseline is main commit `e4cd4375958b91c55a5bd93b00c86656b98a8d13`. The initial planning snapshot contained **216 issues, 947 comments and 230 project-board items**. Board items and issues are different populations; the board count includes items beyond the reviewed issue set.

The review was divided between foundations/records, applications/UI, supporting services and coordination policy. It used the fetched source, current repository specification, issue descriptions, comment history and recorded dependency relationships. Issue claims were compared with the actual owning source paths. Historical comments about an unmerged branch, a worker starting, or a previously successful deployment were not treated as current implementation.

This is an architecture-level source review: repository-wide ownership and implementation inventory, with detailed examination of relevant contracts, service boundaries and representative execution paths. It is not a claim that every source line was independently inspected or that the code was executed. No tests, database review or hosted acceptance were performed for this review.

The [roadmap](README.md) and rewritten issue descriptions carry the current pickup order. Eight additional bounded scopes separate shared prerequisites and later extensions from the earlier functionality they previously blocked. They are tracked as #541–#548: delegated flow execution, managed/durable integration, managed-flow publication, private form/flow integration, the designer workspace, HR leave approval, published query declarations and current Module contract consolidation.

## Governing decisions

- Vortex is a new application platform. Use one current Application contract, one current Module contract and consistent Group terminology. Correct all current consumers together instead of retaining obsolete V1/V2 readers, conversion layers and compatibility aliases.
- Customer-published Module and Application releases remain independently versioned. Draft revisions, immutable releases, explicit installed-version selection and deliberate data upgrades are product behaviour. They are separate from preserving old platform formats.
- Business-specific records, pages, policies and flows belong in application definitions. Core services implement generic capabilities and must not branch on CRM, Service Desk, HR or IAM names.
- Code review against clearly bounded implementation acceptance is the only task-completion review. No new tests, database review, hosted execution, screenshots or proof receipts are required.
- Organisation isolation, current permissions, safe errors, exact values, revision checks and atomic operations remain functionality to implement. Removing verification work does not remove these behaviours.
- A package, schema or pure evaluator is not a completed end-to-end service. A feature is described as delivered only to the extent supported by its actual source path.

## Current implementation by owning component

| Component | What the baseline actually contains | Remaining owning work |
| --- | --- | --- |
| Contracts | Extensive strict definitions, identities, permissions, values, operation shapes and graph declarations. Application and Module formats still have parallel historical branches. | #249 unifies Application; Module contract consolidation unifies Module; #283 removes obsolete Team adapters; feature owners extend the current contract. |
| Database boundary | A real transaction wrapper and private transaction-bound request context. Restricted requests cannot substitute their own trusted identity through a user-settable setting. | Later services reuse this boundary; no second request-context or permission framework. |
| Definition | Real authored-source compilation, permanent identity resolution, validation, publication, immutable dependency selection, history, restore and consumer reads. Native shell/slot/nested/step composition and the Puck adapter are implemented. | Remove obsolete formats under #249 and Module contract consolidation. Complete published query declarations, #250 bindings, and #73 application editing/preview integration. |
| Identity | Sign-in/registration/recovery/session operations, organisation accounts, invitations, tenant/organisation administration and runtime settings. | #72 adds the missing bounded initial application operating-access composition; #407 completes account offboarding. |
| Access | Permission registration, current decisions, row/field scope, groups, roles, assignments, activations, stewardship, direct local sharing and protected administration. | Current Group vocabulary under #283; full governed user journeys under #267; scoped delegated/System execution under #322; sharing under #153/#154. |
| Module | Real storage provisioning, exact reachable Module bindings and Application activation/detach. | #64 supplies explicit upgrade coordination. #408 supplies stored lifecycle policy integration; #46/#404 later handle index and populated incompatible changes. |
| Record | Typed value preparation, exact calculations/totals, protected human saves, fixed storage adapters, private lifecycle primitives, ownership transfer, named set/announce/create effects and partial deadline support. | #48 deadline refresh; #49 supported relationships and owning deletion; #50 remaining action/copy/recovery; #58 real before-save graph integration; #407/#408 administrative lifecycle integration. |
| Query | `runtime/query/src/index.ts` is a service marker. | Published module query declarations and #54 implement actual protected query execution. #39 adds optional reuse later. |
| Rule | Typed condition evaluators and a pure before-save graph interpreter. | #58 must invoke it in the actual protected save and implement current-user interactive execution; #57 later provides condition editing controls. |
| Event | Installed declaration/occurrence projection and a private outbox/logged-queue append composed with record changes. | #60 per-consumer progress/order/retry and #61 bounded dispatch. Existing append must not be rebuilt. |
| Workflow | `runtime/workflow/src/index.ts` is a service marker; typed workflow contracts exist. Operational Kestra flows are not a customer Workflow runtime. | #76 onward implement installed workflow execution, start delivery, triggers, schedules and human work. |
| App | `runtime/app/src/index.ts` is a service marker. | #58 adds headless current-user orchestration; #64 adds installation/runtime assembly; #327 connects the visible application. |
| Page | Real permission-aware page capability projection and composition resolution. The stored adapter currently marks operations unbound. | #66 renderer, #67 data events, #68 page/form state, #69 real operation availability and #250 bindings. |
| Theme | `runtime/theme/src/index.ts` is a service marker. | #71 resolves application appearance and applies common tokens. |
| Search | `runtime/search/src/index.ts` is a service marker. | #89 and related search issues implement queued indexing and permitted search results. |
| File | `runtime/file/src/index.ts` is a service marker; file-related contracts exist. | #92 onward implement private storage, uploads, downloads, attachment use and removal eligibility. |
| Connection | Real instance state, application grants, readiness, health and revocation/reauthorisation foundations. | #99 completes credentials/configuration and management; #100/#101 implement outgoing/incoming execution. |
| Interface | `runtime/interface/src/index.ts` is a service marker. | #102 onward implement published operations and caller surfaces; #200 adds governed external MCP use. |
| Shared UI and Studio | UI is a package marker. Studio contains a real Puck Data adapter, not the complete visual designer or shared runtime renderer. | #66 shared components; Designer workspace, #52/#57 and #65 visual authoring after the first visible application. |
| Web composition | Authentication, session-aware entry and organisation selection exist. The foundation page and organisation page do not render a definition-led record application. | #64 routes/context and #327 connect the installed definition, page model, Query, forms, Record operations and theme. |
| Shipped applications | Worked definitions exist primarily as non-shipping examples; there is no complete shipped application route using them. | #72 administration definitions/setup, #74 CRM/Service Desk, #251 HR and #377 Landing Zone. |
| Operations | Existing operational database-delivery scripts and pinned Kestra configuration. #518's lint-stage correction is present. | Later operational functionality is explicitly scoped; existing delivery tooling is not a development completion gate. |

The table identifies implementation ownership rather than declaring whole historical issues reopened. Completed low-level foundations remain completed when a later integration belongs to another issue.

## Concrete architecture findings and disposition

### One current contract must reach every consumer

#249's older instructions to retain an Application V1 are withdrawn. Current source exports multiple Application contract selectors, legacy defaults and conversion operations. The complete page model and Puck adapter are already present; the remaining job is coherent consolidation, not rebuilding them.

A concrete installation mismatch exists in the baseline: the current `provision_module_installation_storage` body in `20260911090000_resolve_reachable_module_dependencies.sql` requires Application validation/compilation version `1.0.0`, while the native complete Application compiler produces `2.0.0`. #249 must align this real consumer along with Definition, Page and Access.

Event discovery is another consumer: `runtime/definition/src/installed-event-catalogue.ts` imports and unions the Application V1/V2 consumer schemas. It must consume the same sole current Application representation. The file belongs to Definition, despite serving Event.

**Module contract consolidation (#548)** removes parallel Module source/canonical selection and V1-to-V2/V3 conversion code while retaining exact decimal/money values and the shared rule graph in the chosen current contract. It includes Record, Rule, Access, Event and storage consumers. #283 similarly removes old Team serialisation/catalogue adapters without turning ordinary business teams into a second Access principal.

### Protected save does not yet execute the shipped rule graph

The Rule package has `evaluateBeforeSaveRuleGraphs`, but the baseline Record runtime does not invoke it. `save-record.ts` prepares the candidate, evaluates calculations and finalises values without the before-save graph.

#58 owns this missing integration. Applicable rules execute in deterministic order within the owning save transaction; their candidate, requirements and warnings reach the authoritative generators and final validation. A pure interpreter or in-memory composition is not the protected save behaviour.

For current-user flows, declaration ownership precedes execution. **Published module query declarations (#547)** supplies query identities and typed inputs. #250 supplies current Application flow/component declarations and binding resolution. #54 executes protected reads; #58 executes the declared current-user nodes through owning operations. The compiler must not wait for a runtime which itself waits for published bindings.

### Relationships have storage; their supported operations are incomplete

Polymorphic relationship storage already uses a target identity array, and private relationship writing validates the selected target. The earlier claim that no polymorphic storage exists was incorrect.

The demonstrated gaps are narrower: protected save refuses the shape, Access facts omit it, and totals discovery does not follow it completely. #49 aligns these paths. It also composes the private parent-delete policies with an owning Record operation, current permissions, consistent resource order, surviving totals and atomic effects.

Private delete/restore primitives already exist. They are not a substitute for an accessible owning operation. Unmerged rescue branches mentioned in comments were not counted as main implementation.

### Named actions are ahead of their issue description

The current main snapshot includes `create_record` TypeScript composition and `20260921100000_named_action_create_record.sql`, as well as set-field/announce-event and the explicit writer correction.

#50 retains actual missing work: removing the specific create-plus-subject-link refusal, explicit relationship copying, and named deletion/protected restore over #49/#408. All effects of an action remain one transaction; a sequence of separately committed public saves is not the same functionality.

### Deadline, offboarding and lifecycle work are partially implemented

#48's description understated main: the earliest deadline selector, ordinary-save due metadata and a disabled private actor-binding foundation are present. The protected refresh operation, complete affected-parent/action due coverage and system attribution still need implementation. #54 consumes the completed freshness operation; #62 schedules it later.

#407 already has application-contained SQL ownership inventory and an index. It lacks the full runtime service, organisation-wide/shared inventory, bounded transfer orchestration and final deletion fence. #475 remains the single-record transfer owner.

#408 already has policy contracts, validators and pure selection. It still needs protected stored policies/settings, activation/recovery integration and safe previews/removal handoff. #64 depends on this actual policy engine; it must not treat a pure contract as a current stored-policy reader.

### Initial management appointment is not application operating access

The existing configured tenant administration service explicitly nominates a steward and establishes management authority. It does not grant the right to enter CRM or any other business application.

#72 adds a narrow initial-application setup operation: exact nominated account, organisation, selected releases/operating role and persisted setup selection bound to the original provisioning receipt. Resumption uses that original selection; it cannot become a new general granting route. #327's development setup command consumes the operation and #64 installation services.

Access owns the bounded assignment/management-requirement transaction. App or the web/setup composition root coordinates Module and Access; the lower-tier Access service must not import the higher-tier Module service. Private SQL coordinators enforce integrity but do not independently authorise their caller.

This synchronous initial setup is separate from subsequent access expansion through #267's governed IAM journey. Neither tenant status, first sign-in nor a business application name grants access.

### Reads, totals and freshness have distinct owners

#54 applies current row and SQL-owned field bounds before filtering, sorting, grouping, aggregation and pagination. Withheld fields cannot be inferred through counts, ordering or errors. Exact decimal/money values remain exact through results and continuation.

Query reads/refusals do not create per-row or business-change Activity under the current Activity specification. Old issue language demanding a refusal entry for each query is removed.

Stored relationship totals commit with the owning save. #62's proposed separate thirty-second summary catch-up engine had no current specification basis and is removed. Its real scope is bounded deadline scheduling and interruption recovery.

#39 cache reuse and #56 live invalidations use existing Access/Record versions; neither introduces another permission authority. Live notifications contain no business values and trigger an ordinary current authorised read.

### Supporting services need executors, not more placeholder contracts

- Search follows the current queued-index specification. The old synchronous/no-queue assumption in #89 is removed. Current Access is checked when results are returned.
- File delivery requires actual protected storage and transfer operations. Actor attribution must represent the intended current human/system operation directly; a legacy human-only shape is not preserved for compatibility.
- Connection management reuses the real state/readiness foundation. #99 also replaces raw readiness exception messages with safe catalogue-owned errors.
- Workflow execution can consume file-authored definitions before its visual designer exists. It does not require an earlier canvas prototype.
- Copying creates a new editable definition, not records or authority. Sharing is source-authoritative and does not become record duplication.
- #117 owns policy-based removal/archive execution using #408 and legal holds; #116 consumes it for person requests. This avoids mutual ownership of the removal engine.
- MCP remains an external governed interface under #200. Cancelled embedded AI/model work is not reintroduced.

## The Phase 6 result

By the end of Phase 6, an explicitly nominated authorised person can open:

`/{tenant_short_name}/{organisation_short_name}/{application_key}/{page_key}`

The application implementation must:

1. Resolve the current session, organisation, exact installed Application and its bound Module releases.
2. Render the definition's shell, navigation, page composition and appearance through registered shared components.
3. List permitted stored records, open record detail, create and edit through private forms, and run a real named action.
4. Use the same protected Query, Access and Record services throughout, with current revisions, readable fields and truthful operation outcomes.
5. Provide initial and changed-input feedback, typed form continuation and safe handling of unavailable, refused, empty and stale results.
6. Keep publication separate from activation: drafts and new releases do not silently replace the selected installed application.
7. Use shipped current application definitions, not fixture responses, hardcoded business routes or a special permission bypass.

#327 owns the final web composition. #72 supplies administration/setup and #74 supplies the initial CRM/Service Desk definitions. The first release contains the capabilities actually implemented; later services extend its definitions when available.

This result does not wait for the visual designer, complete HR approval workflows, delegated identities, scheduled deadlines, full sharing, connection delivery, MCP or operational recovery. Those retain their own implementation scopes.

## Phase order and dependency corrections

| Phase | Functional outcome |
| --- | --- |
| 1 | Identity, Access and consistent current vocabulary/contracts; main-based development instructions. |
| 2 | Definition publication, Module storage and one current Application/Module representation. |
| 3 | Complete record mutations, deadline refresh capability, ownership/offboarding and lifecycle policies. |
| 4 | Published query declarations, bindings, protected Query and current-user rule/flow execution. |
| 5 | Shared component renderer, page/form states, feedback, themes, preview/publication, installation and permitted runtime controls. |
| 6 | The visible definition-led application described above. |
| 7 | Shared designer workspace, Module/condition editors, complete App Designer, HR pages and personal start pages. |
| 8 | Event delivery needed by indexing, search, private files, query caching and the small capability-admission/reservation foundation. |
| 9 | Durable workflows, schedules, human work, delegated execution, managed flows, HR approvals and scheduled deadline refresh. |
| 10 | Connections, integration operations, public/caller surfaces and MCP. |
| 11 | Sharing, copying/distribution and data import/export. |
| 12 | Privacy, retention execution and complete capability usage/limit administration. |
| 13 | Operational recovery, archives, support and maintenance functionality. |

The small Phase 8 capability-reservation prerequisite is distinct from later complete usage/metering administration. Event dispatch is placed before search rather than waiting for every Workflow feature.

The following splits remove real implementation stalls:

- **Designer workspace (#545)** precedes #52 Module editing and #57 Conditions Designer. #65 then integrates their delivered editors. The whole designer and its children no longer wait on one another.
- #73's early draft/publication/preview completes in Phase 5. **Managed-flow publication (#543)** is an independent Phase 9 extension.
- #58 completes before-save/current-user execution. **Private form/flow integration (#544)** follows #68 in Phase 5 and is required by #327. **Delegated flow integration (#541)** and **managed/durable flow integration (#542)** remain Phase 9.
- #251 supplies editable HR data/pages in Phase 7. **HR leave approval workflow (#546)** is a separate Phase 9 outcome; an inactive authored graph is not presented as executing approvals.
- **Published module query declarations** precedes both #54 execution and #250 binding resolution. Declaration work does not depend on the future executor.
- #46 index upgrades and #404 populated incompatible field changes consume #64's explicit upgrade boundary. They do not prevent a newly authored application from being installed.
- Phase epics describe grouping, not technical prerequisites. Blocked-by links name the specific implementation required by the next owner.

The integrated planning graph was independently checked for missing dependency targets, cycles and backward-phase edges. This is a consistency check on the roadmap artifact, not a runtime acceptance gate.

## Removed work and corrected completion claims

Cancel remaining proof-only or obsolete scope under #29, #55, #172, #173, #254, #271 and #485, and optional hosted queue optimisation #489. Preserve already existing product code and worktree drafts. Cancelled work is not labelled implemented.

Keep #105/#106 out of scope: the platform does not add an embedded assistant/model programme. Keep #5 closed as an application-level commercial concern and #20 superseded by #14.

Retain the #323 prototype as a design reference. Missing real designer interactions belong in #65 shipping code; building another simulated application is not a prerequisite.

Completed foundations, including #224, #252, #386, #387, #395, #396, #401, #430, #455, #475, #508, #511 and #512, remain completed at their actual delivered scope. Historical boundary-documentation and verification-only children #463/#466/#477/#478 do not become new prerequisites. #518's implementation is present and its recorded code review supports completion without another hosted run.

Old dispatch logs, obsolete phase holds and compatibility/proof instructions are replaced by the current concise issue scope. Unique functional decisions are carried into the current description before historical discussion is collapsed.

## Implementation and review discipline

### Second issue-by-issue source review, 22 September

All 439 issues and subissues were reviewed again against main commit `e4cd4375958b91c55a5bd93b00c86656b98a8d13`. Each issue separates code already present from its remaining implementation and links to the relevant source. Parent scopes list their remaining children; only implementation leaves are dispatched. Completed and retired issues have no future pickup, worktree or implementation estimate.

- #10 is complete: the Next.js application shell and package boundaries exist. #327 and its children own the missing installed-application route and runtime composition.
- Existing contracts, pure evaluators, private SQL primitives and package markers do not imply that their public runtime services or UI integration exist. Those remaining operations are named explicitly in the owning leaves.
- #512 changed coordination in existing development setup helpers. It did not change the product storage provisioner.
- #502's checked-in delivery flows already read namespace KV without holding Kestra administrative API credentials. No speculative replacement service is needed. This source finding does not claim anything about live credential rotation.
- #49 and #50 retain their preserved partial candidates; #407 retains its merged inventory portion. Their remaining functionality stays open.
- #520 remains source review of this pull request, with zero additional implementation minutes. These policy changes are not yet on main.

The resulting plan contains 228 remaining implementation leaves. Source inspection supplies the completion distinction; this review does not claim executed, database or hosted validation.

Each task and child issue has a functional summary, bounded architectural build points, specification/source references, current dependencies, code-reviewable acceptance, planned agent, active-work estimate, pickup number and issue-based worktree/branch metadata.

Prefer Luna for mechanical wiring and documentation when the owning contract is fixed, Terra for bounded feature implementation, and Sol for a demonstrated cross-service or authority design problem. Planned model assignment is not evidence that a worker is running.

Estimates cover active implementation and code-review corrections. At the estimate, the coordinator inspects actual progress, the remaining change and any blocker. A progressing worker continues; elapsed time alone never discards a draft or triggers a duplicate worker.

A reviewer checks the actual implementation against the issue's functional acceptance. Development completion does not claim deployment or production operation. The goal of this roadmap is to complete the functionality in a clear pickup order, with the first real visual application delivered by Phase 6.
