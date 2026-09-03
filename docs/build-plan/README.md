# Abzum Vortex revised build plan

**Status:** Approved build plan 2.2

**Date:** 3 September 2026

**Governing specification:** [Abzum Vortex platform specification](../specification/README.md)

**Delivery board:** [Vortex GitHub Project](https://github.com/orgs/Abzum-NZ/projects/2/views/1)

This plan replaces the sequencing of the earlier [Build Plan](https://claude.ai/code/artifact/58852ead-2acc-4ca6-a693-6cb03705bcef). It keeps the useful ownership boundaries while correcting missing dependencies, an impossible background-worker assumption, incomplete fixtures, and an oversized final phase.

The [decision register](../specification/appendices/decisions.md) is clear. Vortex assigns the minimum valid next module or application release version after structural comparison, and the builder confirms or cancels publication. A new unresolved business choice must be recorded before implementation assumes an answer.

## Planning rules

1. A phase starts only when its required earlier outcomes are working, not merely when their issues exist.
2. Every work item links its governing [specification section](../specification/README.md), [data contract](../specification/appendices/data-contracts.md), and any still-open business choice that can change its outcome.
3. Visible work includes desktop and phone evidence under [quality and acceptance](../specification/20-quality-and-acceptance.md).
4. Organisation separation, privacy, migrations, recovery, and observability are part of the feature—not later cleanup.
5. A phase exit is a tested user or platform outcome, not a count of merged files.
6. Work may run in parallel only where the dependency diagram permits it.
7. Before an issue closes, review the specification, data contracts, build plan, traceability and delivery maps, dependent GitHub issues, and native project dependencies. Update every affected source in the same change, or record explicitly that it was reviewed and needed no change.
8. Every core contract and engine feature must pass the [platform-primitives-only admission test](../specification/appendices/core-contract-boundary.md#admission-test). Business domains and Abzum operations are built as ordinary Vortex applications.

## Dependency map

```mermaid
flowchart TD
    G0[Gate 0<br/>Decisions and platform readiness] --> P1[Phase 1<br/>Contracts and complete fixtures]
    P1 --> P2[Phase 2<br/>Definition and Identity]
    P2 --> P3[Phase 3<br/>Access]
    P3 --> P4[Phase 4<br/>Module and Record]
    P4 --> P5[Phase 5<br/>Query, Rule and Event]
    P4 --> P8C[Phase 8 core<br/>Search and File storage]
    P5 --> P6[Phase 6<br/>Application, Theme and Page]
    P6 --> P7[Phase 7<br/>Workflow and pipeline execution]
    P6 --> P8U[Phase 8 experience<br/>File blocks and phone install]
    P8C --> P8U
    P6 --> P9[Phase 9<br/>Connections and Interfaces]
    P7 --> P9
    P8U --> P9
    P6 --> P10[Phase 10<br/>Copy, gallery, sharing, import and export]
    P8U --> P10
    P9 --> P10
    P9 --> P11[Phase 11<br/>Privacy and retention]
    P10 --> P11
    P6 --> P12[Phase 12<br/>Entitlements and metering]
    P7 --> P12
    P11 --> P13[Phase 13<br/>Operational readiness and release]
    P12 --> P13
```

Operations, accessibility, security, documentation, and automated checks are continuous workstreams. Phase 13 proves the complete operating system rather than introducing them for the first time.

## Gate 0 — Decisions and platform readiness

**Status:** Complete in [#151](https://github.com/Abzum-NZ/Abzum-Vortex/issues/151) on 2 September 2026.

**Outcome:** The project has one authoritative approved specification, permanent requirements for settled choices, a clear register, a dependency-complete fixture baseline, and a delivery path that can safely begin contracts.

Required work:

- Verify the settled tenant, definition-version, access, field, workflow, protected data-handling, entitlement, delivery, recovery, and performance requirements against the [data contracts](../specification/appendices/data-contracts.md).
- Keep cluster location out of the product-level sharing choices: one shared-record gateway uses a local adapter or the signed Vortex Federation API.
- Publish Specification 2.0 and update its version history.
- Maintain the dependency-complete [CRM and Service Desk fixture baseline](../specification/appendices/worked-examples.md), including every module, action, connection type, interface, theme, role, workflow, pipeline, page, query, and cross-application scenario. [#15](https://github.com/Abzum-NZ/Abzum-Vortex/issues/15) makes every non-defaultable author choice explicit and proves deterministic, lossless conversion to the canonical contracts before Phase 2 begins.
- Define and validate the [record-table allocation](../specification/17-runtime-storage-and-caching.md#record-table-allocation): one table per compatible record-type storage lineage, explicit organisation/application row scope, stable physical tokens, and collision cases covering same-named applications in different organisations.
- Reconcile the repository README with [delivery and testing](../specification/18-delivery-and-testing.md).
- The completed backup [issue #132](https://github.com/Abzum-NZ/Abzum-Vortex/issues/132) and Supabase migration and database-test foundation [issue #139](https://github.com/Abzum-NZ/Abzum-Vortex/issues/139) are closed. The database scope and request-role guarantees [issue #28](https://github.com/Abzum-NZ/Abzum-Vortex/issues/28) now begin the service-schema path.
- Update [Phase 1 epic #9](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9) so every active M0 gate is a native dependency.
- Assign the existing Priority values to active work, add a real Bugs filter, add roadmap dates when scheduling begins, use native blocked-by links, and add epic completion criteria on the [GitHub Project](https://github.com/orgs/Abzum-NZ/projects/2/views/1).

Exit proof:

- No blocking foundation decision remains open.
- Every fixture reference resolves in a machine-readable dependency check.
- The documented and configured branch checks agree.
- Phase 1 contains only current work and can be moved to Ready.

## Phase 1 — Contracts and complete fixtures

**Current project epic:** [#9](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9)

**Outcome:** Every later service imports one versioned contract package and validates the complete worked examples without a database.

Build:

- Keep the one deployable Next.js composition root and Vercel Root Directory at `apps/web`, following the official Turborepo deployable-application convention; include the workspace files it depends on, run the root `pnpm verify` gate, publish `.next`, and keep shared packages as separate workspace members.
- Shared identifier, error, actor, organisation context, revision, dependency and version-range contracts.
- Independently versioned module and application contracts plus their contained-component contracts from [composition and publication](../specification/03-composition-and-publication.md).
- All core [data contracts](../specification/appendices/data-contracts.md), including the 22 field types, permissions, queries, events, workflow execution references and protected operations, files, connections, interfaces, federation envelopes, protected removal, entitlements, metering and cache versions.
- The formal [core contract boundary](../specification/appendices/core-contract-boundary.md), a documented platform invariant for every privileged contract, and source guards that reject example-specific semantics in core code.
- Generic contract validator with the versioned safe-error catalogue from [the data contracts](../specification/appendices/data-contracts.md#definition-validation-errors), stable codes, caller-mapped builder-visible locations, deterministic ordering, and protected diagnostics. Runtime validation contains no installed definition or fixture name.
- Pure [module/application version-impact comparison](../specification/appendices/version-impact-policy.md), including stable-identity matching, exact content fingerprints, a governed field-by-field policy, Vortex assignment of the minimum valid next release version, and stale-safe builder confirmation or cancellation.
- Storage-catalog and scope contracts that distinguish definition identity, storage lineage, organisation ownership, and application-contained ownership without creating per-installation tables.
- Complete [worked-example fixtures](../specification/appendices/worked-examples.md).
- A capability-complete production authored-source schema and lossless conversion for all 13 example definition documents; no compiler-invented label, permission, layout, public exposure, data shape or business behaviour. Publication consumes immutable prior history, fingerprint-bound active-dependant results and already-published dependencies, and binds every compiled artifact/dependency to its kind, key, root, exact version, canonical content and resolution snapshot.
- Types, lint, unit tests, contract tests and build checks that run without a database.

Exit proof:

- Both complete examples validate with no unresolved reference.
- Every non-defaultable authored choice is explicit, and semantic coverage proves source-to-canonical conversion loses or invents nothing.
- Resolution identity is globally unique across roots and source-derived component owners; changing both a sibling identifier and its claimed owner still refuses compilation, while transformed names, labels, triggers, conditions and dynamic maps never claim a sibling's provenance.
- Edit/save refuses incompatible module-local condition operands, action values, and locally resolvable totals. Publication checks application actions and workflows against their exact bound module versions; calculation, total, record-link and organisation-account result types remain distinct. Totals name an exact source relationship, resolve their field and filter in that relationship's source record, and require the relationship to target the total-owning record. Each aggregate validator has one honest registry owner and a closed emitted-code list.
- Published versions equal the version-impact result, unchanged publication is refused, and every dependency matches its complete immutable kind/key/root/version/content/resolution evidence under the requesting definition's exact snapshot.
- Record-scoped pages, blocks, queries, actions and replacements share one record target; public pages and interfaces prove their complete query, field, permission, action subject and action effect surface is public-safe.
- Every workflow trigger matches its owning action, message, inline recurrence, interface or exact parent-workflow contract; trigger consumers, link assignments, file operations, and every fixed or form-declared node output are typed, duplicate-protected where required, record-targeted where applicable, and tested as producer/consumer pairs.
- Every record type resolves to exactly one collision-free storage mapping; two same-named CRM applications in different organisations remain isolated, while CRM and Service Desk can read the same organisation-shared Company and Contact records.
- Invalid examples cover every closed list, missing required value, unknown value, incompatible reference and cross-root version failure.
- Schema failures and validation-rule failures produce the same safe public result; adversarial diagnostics never enter that result and no example-specific name appears in the translator or catalogue.
- First publication is exactly `1.0.0`, unchanged content cannot publish, and patch/minor/major fixtures prove deterministic reasons, minimum version assignment, history integrity, and stale-confirmation refusal.
- No service-specific package invents a second form of a shared contract, and no core package recognises an example application or ordinary business domain by name.
- The final Phase 1 revision passes `pnpm verify` from a clean checkout and is recorded moving through the protected feature-to-Testing-to-Production Vercel path.

## Phase 2 — Definition and Identity

**Current project epic:** [#18](https://github.com/Abzum-NZ/Abzum-Vortex/issues/18)

**Needs:** Phase 1.

**Foundation order:** migration and database-test delivery [#139](https://github.com/Abzum-NZ/Abzum-Vortex/issues/139) and database guarantees [#28](https://github.com/Abzum-NZ/Abzum-Vortex/issues/28) are complete. Tenant and organisation structure [#23](https://github.com/Abzum-NZ/Abzum-Vortex/issues/23) and the identity authority [#25](https://github.com/Abzum-NZ/Abzum-Vortex/issues/25) are now unblocked and may proceed in parallel. Definition storage [#19](https://github.com/Abzum-NZ/Abzum-Vortex/issues/19) follows #23; organisation accounts [#24](https://github.com/Abzum-NZ/Abzum-Vortex/issues/24) follow both #23 and #25. Native GitHub dependencies enforce the order.

**Outcome:** A person can sign in, choose an organisation, tenant administrators can manage a safe organisation hierarchy, and authorised builders can draft, validate, publish and restore modules and applications independently.

Build:

- One environment-wide [Vortex Identity Authority](../specification/02-people-organisations-and-sign-in.md#identity-across-clusters), plus tenants, tenant-administrator assignments, acyclic organisation hierarchy, cluster-local organisation accounts, invitations, sessions and organisation launcher.
- Supabase Auth with a managed P-256 `ES256` signing key and locally verifiable short-lived identity tokens. The Identity service accepts the required standard Supabase claims, then returns only the closed global identity result, including the permanent identity identifier and verified primary email. It uses no custom access-token hook and never turns provider roles or metadata into Vortex authority.
- Neutral bootstrap sign-in with one global identity and a separate account in every organisation the person belongs to.
- Local email confirmation and recovery are captured in Mailpit. Testing proves them through approved custom SMTP and dedicated non-customer addresses. Production SMTP provisioning and proof remain Phase 13 work under #171.
- Identity Authority [#25](https://github.com/Abzum-NZ/Abzum-Vortex/issues/25) owns token verification. Organisation accounts [#24](https://github.com/Abzum-NZ/Abzum-Vortex/issues/24) consume the verified identity identifier and email; sessions [#26](https://github.com/Abzum-NZ/Abzum-Vortex/issues/26) consume the same result and own durable cookies, refresh, sign-out and revocation.
- Independent module and application draft concurrency, release versions, validation, immutable revision publication, dependency graph and restore. Themes, pages, workflows, interfaces and application roles remain contained in the application; organisation roles remain live access data.
- Platform bootstrap definitions required before the Page service exists.
- One closed request context established for each protected transaction through a non-owning request role. Vercel uses the Supabase transaction pooler with prepared statements disabled; Kestra keeps a separately credentialed session-pooler path for migrations and database verification.
- The official Supabase CLI project, ordered migration history, local pgTAP/lint gate, and Kestra Testing/Production delivery path exist before a service schema is introduced. Kestra runs the same committed pgTAP files through a pinned in-image `pg_prove` harness, so operated verification does not require the host Docker socket.

Exit proof:

- One identity can safely switch between its separate accounts in two organisations without transferring profile, role or cached state between those accounts.
- Two independently configured verifier instances accept the same Testing identity token, produce the same identity identifier and verified primary email, and refuse a token from another environment. This proof does not require or claim a second physical Testing cluster.
- A stale draft cannot overwrite a later edit.
- Publishing is atomic and a restored version becomes a new draft.
- Definition and identity tables pass their database separation tests.
- The delivery engine is bootstrapped from one exact reviewed commit, produces successful Testing evidence after that commit merges to `testing`, and returns Coolify to the same revision on protected `main` before ordinary automatic delivery begins.
- Tenant administrators can create and move organisations without gaining record access, and cross-tenant or cyclic hierarchy moves are refused.

## Phase 3 — Access

**Current project epic:** [#31](https://github.com/Abzum-NZ/Abzum-Vortex/issues/31)

**Needs:** Phase 2.

**Outcome:** One permission vocabulary and test catalogue protects database rows and every server surface.

Build:

- Permission, role, assignment, team/group and application-access contracts.
- Canonical PostgreSQL allow/refuse function for row operations.
- Server Access library for files, caches, search, connections, workflows and interfaces.
- The sole application-role `*` entry expanded only against that exact application's non-administrative permission catalogue and fingerprinted at publication; organisation roles and module permissions remain exact-only.
- Multiple team memberships per organisation account and within-organisation direct record sharing to an account or team with field allowlists.
- Access-version ownership and revocation path.
- Field-level response filtering where specified.
- Source-authoritative grant evaluation that can be called through the same local or federated shared-record gateway contract.
- Split database and end-to-end [organisation separation suite](../specification/20-quality-and-acceptance.md#organisation-separation-suite).

Exit proof:

- Every database case fails through the request role and succeeds through the matching owner control operation.
- File, cache, subscription and server tests run through real product boundaries, not a table-owner fiction.
- Removing a role, membership, share, or account changes access on the next request.

## Phase 4 — Module and Record

**Current project epic:** [#42](https://github.com/Abzum-NZ/Abzum-Vortex/issues/42)

**Needs:** Phase 3.

**Outcome:** Builders can install modules and people can safely create, change, delete and restore records with all field and relationship rules enforced.

Build:

- Module dependency, install, upgrade and removal planning.
- Storage generation through ordered [database changes](../specification/18-delivery-and-testing.md#database-changes).
- All 22 field types, relationships, closed calculations and typed totals through resolved module definitions.
- Record save sequence, concurrency numbers, reference sequences, uniqueness, ownership and data versions.
- Soft deletion, restoration, permanent-removal handoff and bounded bulk operations.
- Migration workflow for incompatible field changes; no arbitrary in-place retype.

Exit proof:

- CRM records pass create/change/conflict/delete/restore tests.
- Parent deletion is refused for unresolved required links except explicit dependent-child soft-delete; soft-deleted unique values remain reserved; mixed-currency totals refuse; and incompatible field changes follow add/migrate/switch/retire.
- A failed save produces no record change, activity entry or event.

## Phase 5 — Query, Rule and Event

**Current project epic:** [#53](https://github.com/Abzum-NZ/Abzum-Vortex/issues/53)

**Needs:** Phase 4.

**Outcome:** Every surface can use one safe query contract; immediate rules run during saves; committed events reach consumers in record order.

Build:

- Filter, sort, grouping, total, pagination and saved-view contracts.
- Safe database query compilation with no dropped predicates.
- Client and server rule evaluation with server authority.
- Transactional event outbox, [Supabase Queue](https://supabase.com/docs/guides/queues), webhook wake-up, sequence barrier, retry, failed-event handling and recovery call.
- Private Supabase Realtime Broadcast channels that send content-free invalidations and force an authorised reload.
- Search/file data-version hooks needed by later phases.

Exit proof:

- Lists, summaries and exports agree on access and filter meaning.
- Unsafe filters refuse rather than broaden.
- Duplicate delivery is safe and a later record event never discards or overtakes an earlier blocked event.
- Database-webhook wake-up and scheduled Kestra recovery both deliver from the durable queue without duplication.

## Phase 6 — Application, Theme and Page

**Current project epic:** [#63](https://github.com/Abzum-NZ/Abzum-Vortex/issues/63)

**Needs:** Phase 5.

**Outcome:** Builders can compose and publish complete applications that people can use on desktop and phone.

Build:

- Version-pinned module and connection bindings, exact one-for-one resolved-dependency manifests, application roles, navigation and application resolution. Publication requires each declared version requirement to accept its resolved version and each connection binding to supply the exact caller-snapshot artifact and operation catalogue.
- Application-contained theme settings, platform-theme binding, inheritance and legibility checking.
- Six page types, four list arrangements, registered blocks, twelve-column responsive layout and page states.
- [Next.js client-side navigation and scoped loading](../specification/07-applications-pages-and-themes.md#core-ui-continuity-and-motion): persistent application shell, route and block loading boundaries, on-demand code and data, component-level refresh, restrained state transitions, and equivalent reduced-motion behaviour. Use Motion for React for coordinated presence and layout changes, CSS transitions for simple control feedback, the six central semantic tokens, interruptible state-driven motion, and lazy-loaded Motion features; do not depend on experimental Next.js View Transitions.
- Forms, guided-form drafts, action buttons and public pages.
- A permission-filtered [semantic interface map](../specification/07-applications-pages-and-themes.md#semantic-interface-map) for navigation, pages, queries, forms, drafts, choices, files, actions, Studio and administration. Web components bind to these stable semantic controls so Phase 9 can expose the same capabilities without describing the DOM or rebuilding application behaviour.
- Complete process-pipeline definition, transition gates and visible stage controls. Timed execution comes in Phase 7.
- The protected sign-in and recovery shell, plus locked Tenant Administration and Organisation Administration application definitions built with the same application/page primitives as customer applications.

Exit proof:

- Complete CRM and Service Desk applications each publish as one root revision with exact module-version bindings.
- Every fixture page passes desktop, phone, keyboard, validation, empty, refused, conflict and failure checks that apply.
- Internal navigation never performs a routine full document reload; slow routes and blocks show immediate local feedback, and refreshing data updates only affected components and dependent totals without losing unrelated state.
- A delayed response or unfinished animation for an obsolete record, page, or access state never flashes or replaces the current authorised state; no feature defines its own motion timing or spring.
- Direct addresses cannot bypass page and action permissions.
- The published semantic map contains every meaningful discoverable interface control, omits view-refused controls, and marks a discoverable-unavailable control as non-invocable without exposing its permission key. It uses stable identifiers rather than labels, selectors or coordinates. Form-draft revisions prevent a later browser or future MCP client from overwriting newer input.

## Phase 7 — Workflow and pipeline execution

**Current project epic:** [#75](https://github.com/Abzum-NZ/Abzum-Vortex/issues/75)

**Needs:** Phases 5 and 6.

**Outcome:** Durable workflows and pipeline time targets execute with [Kestra](https://kestra.io/docs) authoritative for execution status while Vortex remains authoritative for application records and access.

**Foundation order:** Before application-workflow execution [#76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76), [#198](https://github.com/Abzum-NZ/Abzum-Vortex/issues/198) must align the pinned Kestra release and its state-database major on an officially supported combination. The change requires a verified off-host backup, a disposable restore rehearsal and a forward migration; an existing PostgreSQL data directory is never opened by an older major.

Build:

- Workflow triggers and the governed 24-node catalogue: flow control, bounded queries and loops, record actions, generic human-input waits, files, and named connection operations.
- Comments, tags, tasks, calendar entries, notifications, documents and ordinary approvals remain application records and actions. External delivery uses named connection operations instead of privileged business nodes.
- Refusal of arbitrary SQL, JavaScript, shell, unrestricted expressions, arbitrary network/file operations, and builder-supplied executable nodes.
- Versioned signed protected-operation contract and duplicate-safe application side effects.
- [Kestra](https://kestra.io/docs) flow generation, execution start, authoritative status reads, outage display, and operator correlation.
- Pipeline stage-time targets, events and escalation workflows.

Exit proof:

- The qualification and deal-won workflows survive retry, callback duplication, web deployment and [Kestra](https://kestra.io/docs) restart.
- Every completed, waiting, cancelled and failed run displays Kestra's current state; Vortex's last-known snapshot is labelled unavailable rather than presented as current during an outage.
- Phase 7 uses the Phase 6 action, form, page and pipeline contracts rather than inventing replacements.

## Phase 8 — Search and File

**Current project epic:** [#87](https://github.com/Abzum-NZ/Abzum-Vortex/issues/87)

**Needs:** Phase 4 for core storage; Phase 5 for derived updates and purge queues; Phase 6 for blocks, pages, theme and install experience; Phase 7 for scheduled removal and application-defined message delivery.

**Outcome:** People can find permitted records and safely upload, preview, download, restore and remove files.

Build in two streams:

- **Core after Phase 4:** search documents, ranking, access recheck, file metadata, private Supabase Storage buckets, signed and resumable transfers, upload/download grants, detection, scanning, quarantine and lifecycle.
- **Experience after Phases 5–7:** page blocks, attachment controls, previews, live search freshness, phone installation, generic capacity notices, scheduled purge and recovery.

Exit proof:

- Search and file paths pass their end-to-end organisation-separation cases.
- Sensitive fields never enter general search or file-derived search.
- Attachment configuration uses one decided contract.
- Deletion, retention, legal hold and restore paths are integrated, not deferred.

## Phase 9 — Connections and Interfaces

**Current project epic:** [#98](https://github.com/Abzum-NZ/Abzum-Vortex/issues/98)

**Needs:** Phases 6–8.

**Outcome:** Approved systems and registered Vortex clusters can interact through narrow, versioned, monitored operations, and an authorised external MCP client can use the same governed capabilities as its person's web interface.

Build:

- Connection types and instances, OAuth lifecycle, secret rotation, outgoing operations, incoming verification, network-address safety, shared retry budgets and health.
- Versioned interface operations, authentication, duplicate protection, rate limits, compatibility ranges and deprecation.
- One governed remote [MCP surface](../specification/12-connections-and-interfaces.md#governed-mcp-access), delivered by [issue #200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200), using revision `2026-07-28`, Streamable HTTP, mandatory `server/discover`, per-request revision, client-information and capability metadata, pagination and safe change notification. The HTTP adapter separately validates the required protocol-version, method, applicable name and declared-parameter headers against the body, refuses invalid origins or header mismatches, accepts modern MCP messages only by negotiated `POST`, exposes no modern `GET`, and remains stateless. Use the Supabase Auth OAuth 2.1 server for discovery, authorization code with PKCE, refresh rotation and administrator pre-registration; keep deprecated dynamic registration disabled and bind audience-restricted tokens to separate live Vortex organisation-account/application/capability grants.
- A small generic resource and tool set projected from the Phase 6 semantic interface map. It covers context and navigation, query controls, form and guided-form drafts, validation and submission, files, named actions, Studio and administration without generating one tool per button or exposing a schema-free data bypass.
- Optional, explicit live-interface pairing for semantic navigation, form updates and actions. Pairing is visible, expiring and revocable, carries expected state revisions, and never exposes browser cookies, DOM handles, selectors, coordinates or unrestricted browser control.
- One execution path: web and MCP call the same access, validation and platform services and produce the same records, events, activity meaning, duplicate behaviour and safe errors. Vortex hosts no model, assistant, sampling request or autonomous agent loop.
- [Federation transport and cluster trust issue #157](https://github.com/Abzum-NZ/Abzum-Vortex/issues/157): Vortex cluster directory, signed manifests, request-signing and verification library, replay protection, and version negotiation used by the [federation runtime](../specification/17-runtime-storage-and-caching.md#vortex-federation-between-clusters).

Exit proof:

- Connection addresses cannot reach unapproved private infrastructure.
- Incoming and interface writes are safe under replay.
- Deprecated interface versions cannot be removed while a protected dependency remains.
- Automated parity evidence proves the same identity and organisation account sees and can use the same permitted capability inventory through web and MCP, while refused fields and controls are absent from both.
- Form, file, action, Studio and administration scenarios produce the same outcome through web and MCP; revocation applies on the next request and stale paired-interface revisions are refused.
- Authorization tests refuse invalid-issuer, expired, revoked, wrong-audience, wrong-client and pass-through tokens. A separate access test refuses operations outside the live Vortex grant/current account and proves extra standard identity scopes grant nothing. Every request declares its revision, client information and capabilities in `_meta`; `server/discover` reports the supported set; unsupported or legacy connection-scoped revisions fail safely. Transport tests refuse an invalid `Origin` and missing or mismatched required headers with the defined safe error, verify required `POST` content negotiation and prove the modern endpoint is stateless and has no `GET` behaviour.
- [Issue #157](https://github.com/Abzum-NZ/Abzum-Vortex/issues/157) proves signed two-cluster transport, replay refusal, compatible rolling versions, key rotation, route shutdown, and bounded outage before record-sharing operations use it.

## Phase 10 — Copy, gallery, sharing, import and export

**Current project epic:** [#109](https://github.com/Abzum-NZ/Abzum-Vortex/issues/109)

**Needs:** Phases 6, 8 and 9. The sharing and copy policies are settled in the specification.

**Outcome:** Definitions move without source records, record files move through explicit import/export formats, and approved recipients can use narrowly shared live records without copying them, with the same product behaviour inside one cluster and across clusters.

Build:

- Signed definition package manifest, dependency preview, identifier remapping, incomplete-draft handling and reviewed gallery.
- Clear Organisation Administration application separation between installing definitions and sharing live records.
- Access-owned sharing grants with one explicit scope, one recipient application, one or more recipient application roles, action/field allowlists, export defaulting off, required expiry, and source-authoritative revocation.
- Inter-application collaborative grants that keep the source record authoritative while allowing only named fields and published shareable actions; the CRM and Service Desk fixture proves a limited case presentation with controlled changes and no copied summary record.
- Published, version-pinned saved sharing conditions with declared parameters; no inline grant filters and no silent widening after publication.
- Protected source consent and recipient consent over the same complete proposal fingerprint for every cross-organisation grant.
- [Cross-cluster execution issue #156](https://github.com/Abzum-NZ/Abzum-Vortex/issues/156): one shared-record gateway with a local adapter and signed remote adapter; source-authoritative query, action, file, revocation, and audit behaviour.
- Signed duplicate-safe cross-cluster proposal, consent, activation receipt, revocation notice, and status reconciliation.
- Protected exact sharing-code or invitation-link recipient discovery, and linked source/recipient metering allocation without double counting.
- Ordinary list, detail, search-result, report, dashboard-block, action, and approved-export components backed by the shared-record gateway, with visible source ownership and source-unavailable states.
- Source-executed shared search, reports, and exports with no recipient index, materialised report result, persistent record/file copy, workflow payload, or cross-request shared-data cache.
- Source-owned file access, activity, protected data handling, same-cluster tests, and two-cluster tests.
- Record import mapping, dry run, duplicate policy, bounded background execution and result report.
- Access-checked expiring record export.
- Complete encrypted organisation archive and controlled restore as a separate operator operation.

Exit proof:

- Cross-organisation copy removes or remaps organisation-specific state.
- Installing a definition never grants record access, and a record grant never copies or installs a definition.
- Ordinary record edits cannot activate grants; every grant proves source and recipient consent over one fingerprint; a changed condition, role, field, action, export choice, region, or expiry requires both consents again.
- Source revocation takes effect on the next request; sensitive fields, inline conditions, live re-sharing, recipient indexing, materialised shared reports, persistent remote copies, and unapproved export are refused.
- Revoking the fixture's case grant removes already rendered values on the next access check and prevents browser history, client cache, subscriptions, or offline state from retaining access.
- Shared lists, details, search, reports, dashboard blocks, actions, files, and approved exports have the same permission and result meaning through local and remote adapters while clearly showing source ownership.
- The same fixture grant passes through both local and remote adapters with the same fields, actions, activity meaning, and stable refusal codes.
- A lost cross-cluster message reconciles safely; an altered, replayed, expired, incorrectly addressed, or version-incompatible request fails closed.
- Exact sharing-code or signed-link discovery reveals only the approved organisation name and region; one shared request creates linked source/recipient metering without counting one category twice.
- An approved export is generated at the source, leaves no recipient-cluster copy, includes only approved fields, and presents the non-recallable-download responsibility before transfer.
- Import dry run matches execution.
- Complete archive restore proves definitions, roles, records, files, workflow state and privacy-removal replay.

## Phase 11 — Privacy and retention

**Project epic:** [#164](https://github.com/Abzum-NZ/Abzum-Vortex/issues/164)

**Needs:** Every service that stores personal or derived content.

**Outcome:** The platform can inventory, find, export, restrict, retain, hold and erase personal data across every active and restored copy.

Build:

- Data inventory and personal-data discovery.
- Retention policy preview, scheduling, resumable removal and non-content receipts.
- Legal holds and protected operation authorisation.
- Organisation-scoped person-data export and erasure across records, files, search, events, workflows, activity details, exports, caches and configured connected systems; global identity closure coordinates every organisation account.
- Removal-receipt replay during restore.

Exit proof:

- A seeded person's data is found and handled across every listed category.
- A legal hold prevents removal without increasing read access.
- A restore test does not resurrect permanently removed content.

## Phase 12 — Entitlements and metering

**Project epic:** [#165](https://github.com/Abzum-NZ/Abzum-Vortex/issues/165)

**Needs:** Identity plus the first resource-consuming services.

**Outcome:** Arbitrary platform services make one versioned allow/refuse entitlement decision and record duplicate-safe, tenant-scoped metering without understanding commercial products or payment state.

Build:

- Versioned entitlement policy assignments and protected administration operations.
- One generic check/decision boundary with tenant scope, optional organisation attribution, capability key, quantity, unit, policy revision and safe refusal code.
- Reservation, commit and release behaviour for scarce concurrent resources where a simple decision would race.
- Duplicate-safe immutable metering events, read models and reconciliation.
- Generic accessible banner presentation in the Phase 6 design system; application-authored notices remain ordinary application records.

Exit proof:

- Replayed entitlement or metering requests do not double-reserve or double-count.
- Removing an entitlement refuses new consumption without deleting existing application data or granting record access.
- Every reported quantity can be reconciled to immutable metering events and explicit corrections.
- No core schema, table, service or task contains product, price, subscription, invoice, payment-provider or active-person charging semantics.

## Phase 13 — Operational readiness and release

**Project epic:** [#166](https://github.com/Abzum-NZ/Abzum-Vortex/issues/166)

**Needs:** Phases 1–12.

**Outcome:** The complete platform can be deployed, observed, supported, recovered and released against measured promises.

Build and prove:

- Measures, alerts, incident records and tested runbooks from [operations](../specification/19-operations-backup-and-recovery.md).
- Continuous seven-day Supabase point-in-time recovery plus hourly encrypted logical backups in the existing Cloudflare R2 backup account under a separate Vortex bucket or prefix, with a 48-hour requested expiry, hourly cleanup, lifecycle backstop, scheduled restore, workflow reconciliation, file integrity and privacy-removal replay.
- SSL enforcement, exposed-schema review and platform adviser review. Supabase CIDR restrictions are deferred until both Kestra and Vercel have stable outbound IP ranges; DNS names cannot be allowlisted.
- No read replica in the first release; measured demand must create and justify future work.
- Secret inventory and rotation drills.
- Production Auth SMTP provisioning with a verified sender, Doppler-held credentials, delivery monitoring, rate-limit review, rotation and confirmation/recovery proof before customer use.
- Full separation, accessibility, measured performance, load, failure and recovery acceptance. Performance findings create work but never block a release by themselves.
- The complete web/MCP parity matrix from [quality and acceptance](../specification/20-quality-and-acceptance.md#mcp-parity-acceptance), including permission removal and live-interface pairing, against the release candidate.
- Production release checklist, change record, support boundary and customer communication path.

Exit proof:

- Restore evidence meets the one-hour recovery-point and eight-hour recovery-time objectives.
- No blocking decision, unresolved reference, critical alert, untested migration or failed acceptance case remains.
- The release candidate is traceable from specification and decision through issue, code, migration, evidence, deployment and runbook.

## Project-board operating structure

The [GitHub Project](https://github.com/orgs/Abzum-NZ/projects/2/views/1) follows these implemented rules:

1. Gate 0 [#151](https://github.com/Abzum-NZ/Abzum-Vortex/issues/151), repository boundaries [#10](https://github.com/Abzum-NZ/Abzum-Vortex/issues/10), identifier/reference contracts [#11](https://github.com/Abzum-NZ/Abzum-Vortex/issues/11), the original contract delivery [#12](https://github.com/Abzum-NZ/Abzum-Vortex/issues/12), safe validation errors [#13](https://github.com/Abzum-NZ/Abzum-Vortex/issues/13), version impact [#14](https://github.com/Abzum-NZ/Abzum-Vortex/issues/14), authored-definition compilation and validation ownership [#15](https://github.com/Abzum-NZ/Abzum-Vortex/issues/15), complete fixtures [#16](https://github.com/Abzum-NZ/Abzum-Vortex/issues/16), the P0 platform-primitives correction [#186](https://github.com/Abzum-NZ/Abzum-Vortex/issues/186), and final delivery evidence [#17](https://github.com/Abzum-NZ/Abzum-Vortex/issues/17) are complete. The Phase 1 epic [#9](https://github.com/Abzum-NZ/Abzum-Vortex/issues/9) is closed.
2. Native GitHub blocked-by relationships govern sequencing; body text explains but does not replace them.
3. Every phase epic has an outcome and completion evidence.
4. Phases 11–13 use epics [#164](https://github.com/Abzum-NZ/Abzum-Vortex/issues/164), [#165](https://github.com/Abzum-NZ/Abzum-Vortex/issues/165), and [#166](https://github.com/Abzum-NZ/Abzum-Vortex/issues/166). Activity/protected data handling/retention, entitlements/metering, and operations issues belong to those epics rather than Phase 10. Commercial applications do not block the generic platform roadmap.
5. Extension-point use belongs to Phase 4 and standard-page replacement belongs to Phase 6; they are no longer deferred to distribution work.
6. Priority is explicit on every project issue: `P0 — Critical`, `P1 — Next`, `P2 — Planned`, or `P3 — Later`. The Bugs view filters `label:bug`; roadmap dates and Iteration remain empty until work is genuinely scheduled.
7. Completed backup [issue #132](https://github.com/Abzum-NZ/Abzum-Vortex/issues/132), Supabase migration and database-test foundation [issue #139](https://github.com/Abzum-NZ/Abzum-Vortex/issues/139), and database guarantees [#28](https://github.com/Abzum-NZ/Abzum-Vortex/issues/28) are closed. Tenant hierarchy [#23](https://github.com/Abzum-NZ/Abzum-Vortex/issues/23) and identity authority [#25](https://github.com/Abzum-NZ/Abzum-Vortex/issues/25) are the current parallel Phase 2 workstreams.
8. Every later board change follows the current specification and keeps the decision register limited to genuinely open business choices.
