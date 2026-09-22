# 20. Implementation quality and code-review acceptance

[Specification index](README.md) · [Development delivery](18-delivery-and-testing.md)

## Definition of complete

A development capability is complete when its bounded functionality is implemented, a separate code review confirms the issue's acceptance criteria, and the reviewed changes are merged. Parent tasks complete when their implementation children complete.

Do not create or run tests, require database review, request hosted evidence, or add proof, screenshot, benchmark, deployment or release gates to development tasks. Code review is the only acceptance method for this build. Completion describes implemented code, not production readiness.

## Functional quality

Visible functionality implements [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) Level AA. Any platform limitation has a documented remediation plan. This is a product requirement assessed in code review, not a separate testing or evidence gate.

Review code against the owning specification, focusing on behavior rather than test instructions:

- Organisation scope and current account/role permissions are enforced by the owning service on each protected operation. A page hiding a control is not authorization.
- Rows, fields, files, search results, totals, subscriptions, caches and errors expose only permitted content. Switching organisation clears the old context; tenant administration does not imply child-organisation data access.
- Atomic operations keep values, relationships, totals, activity and events consistent. Revision checks refuse stale writes. Duplicate-protection keys do not create repeated effects.
- Published definitions have explicit identities and selected versions. Draft save, publication and activation remain separate user operations. There is one current contract representation; legacy readers and backward-compatibility layers are not required.
- UI components have keyboard and focus handling, readable errors, component-scoped loading, responsive layouts and reduced-motion behavior. Late responses cannot overwrite a newer selection or expose withdrawn content.
- Definition-led applications use generic engines and ordinary definitions. Business names, approval policies and special cases do not enter core runtime code.
- Frontend flows use typed inputs and variables, explicit operation calls, and current or delegated execution identities. Rendering, prefetching and retries do not manufacture writes. The original human remains attributable.
- A presentation-only flow may finish without saving. Each protected write owns its transaction. A later sequential failure preserves earlier confirmed commits and accurately reports the partial result.
- Forms, clicks, keyboard submission and record gestures use the same declared action flow. Default Save form is an explicit operation node, not a hidden component writer.
- Web and governed MCP capabilities call the same operation services when their owning roadmap phase implements them. Later MCP delivery does not block the phase-6 web application.
- Shared records remain source-authorized and obey consent, scope, expiry and revocation. Cross-cluster transport does not persist source values in the recipient or silently broaden grants.
- File removal, privacy restrictions, legal holds, retention and restore use their owning product rules. No role or environment shortcut bypasses them.
- Secrets and private content stay out of browser bundles, safe errors and operational logs.

## Review scope

The issue's What will be built section names the owning code, inputs, outputs, dependencies and excluded work. Acceptance criteria describe observable implementation behavior and structures a reviewer can inspect. They do not add a second implementation of the same feature, an unnecessary framework, an approval service, or a verification project.

Use the simplest design that meets the current specification. Correct an unsuitable contract or schema at its source. Published product revisions remain useful functionality; retaining an obsolete platform serialization is not required for this new application.

<a id="organisation-separation-suite"></a>

## Organisation separation behavior

Organisation separation applies at every boundary described by [People and organisations](02-people-organisations-and-sign-in.md), [Access](04-access-and-permissions.md), [Records](06-records-and-lifecycle.md), [Files](11-files-and-attachments.md), [runtime storage](17-runtime-storage-and-caching.md) and [sharing](16-copying-sharing-import-export.md). The implementation has these required outcomes:

- An authenticated identity acts through one current organisation account and one explicit application context per request. Membership or authority in another account, tenant, organisation or application never combines with the current context.
- Record rows, relationships, calculated values, Activity, Event, files, live updates, search, reports, exports, caches and workflow state remain scoped to the current permitted organisation and application. Browser navigation, background work and retries cannot reuse stale scope.
- Request/runtime roles have only their declared protected routes. A table owner, migration identity, service credential, URL parameter, hidden UI state or direct helper call cannot stand in for an authorised application caller.
- Organisation switching clears account-specific server and client state. Back navigation, a late response, subscription delivery or cache entry cannot reveal content from the previous context.
- Tenant administration exposes only the hierarchy and operations explicitly granted by the tenant contract. It does not imply a child-organisation account, local administration, record access or application use.
- Identically named organisations, applications, roles, permissions and records retain distinct permanent scope. Display names and authored labels never select authority.

Shared-record behavior remains source-authoritative:

- A grant has the exact source, recipient, applications, role, fields, actions, saved condition, lifetime and consent fingerprint approved by both sides. A changed proposal or saved condition requires a new explicit grant decision; recipient input cannot widen it inline.
- The recipient receives only permitted response values. Source record values do not become recipient database rows, files, search indexes, materialised reports, workflow state, cross-request cache, logs, traces or grant-mirror content.
- Lists, detail, search, reports, dashboard blocks, named actions, files and approved exports have the same permission meaning through local and remote adapters. Source ownership and temporary source unavailability remain visible.
- Revocation, expiry, account removal, application-role loss, record deletion and field-policy reduction affect the next operation. Client state and live subscriptions close or re-authorise without retaining withdrawn values.
- Signed federation validates source, destination, audience, body, contract identity, issue/expiry time and one-use nonce before a business query. Invalid, replayed, expired or unsupported requests fail with a safe stable result. Duplicate-protection keys prevent a repeated accepted action from applying twice.
- Recipient discovery by sharing code or signed link returns only the approved minimal organisation identity for an exact active value. It is not an enumerable directory.

Application and role administration preserve scope:

- Registering or publishing an application assigns no access. Explicit installation/activation selects its exact release; new or broadened permissions require an authorised assignment, while removed permission or withdrawal becomes ineffective immediately.
- One organisation role may contain permissions from several applications without merging their application scopes. Application administration grants neither organisation administration nor another application's authority.
- Direct-account and Group assignments use the same protected organisation-role operations. Foreign account, Group, role, application or permission identities are refused.
- At least one effective direct permanent organisation steward remains. An expiring, eligible-only or Group-derived delegate cannot silently replace that invariant.

## Groups and privileged access

The [Groups and privileged-access contract](appendices/groups-and-privileged-access.md) governs current eligibility and activation. Eligibility alone grants no use when activation is required. Activation elevates only the selected member for the bounded role, application, time and policy; required recent authentication and independent human approval remain product rules owned by IAM, not extra fleet reviewers.

Metadata changes, narrowing and pending additions preserve still-approved active authority while removed permission stops immediately. Added or restored authority requires a fresh activation. A mode or policy change cannot convert, revive or silently broaden a revoked, expired, scheduled or otherwise ineffective assignment.

The [IAM application](appendices/iam-application.md) keeps requests, approvals and protected effects linked to exact organisation accounts, Groups, role/application versions and proposal content. Editing an ordinary request/review record, substituting an approver, replaying a workflow result or invoking a private helper cannot grant access. A workflow outage leaves the proposal pending; immediate authorised removal remains available.

<a id="accessibility-acceptance"></a>

## Accessibility and interaction behavior

Visible functionality meets [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) Level AA unless a documented platform limitation has an owned remediation. Keyboard and focus order, readable labels and errors, contrast, zoom, supported responsive layouts and reduced-motion behavior are part of the implementation.

Normal, empty, loading, validation, refused, conflict, failure and recovery states preserve the same meaning at supported widths. Internal navigation keeps the application shell and unrelated unsaved state intact. A slow route or component supplies local progress, and a refresh changes only affected components and dependent totals.

Motion uses the central semantic tokens and remains interruptible. A late response or transition for record A cannot flash, regain focus or replace state after the user has moved to record B. Reduced-motion mode communicates the same state change without depending on animation.

<a id="mcp-parity-acceptance"></a>

## Web and MCP parity

The governed [MCP surface](12-connections-and-interfaces.md#governed-mcp-access) projects the published [semantic interface map](07-applications-pages-and-themes.md#semantic-interface-map). For the same identity, organisation account, application revision and access revision, web and MCP expose the same permitted navigation, fields, choices, drafts, files, actions, Studio controls and administration meaning.

- View-refused content is disclosed by neither surface. A discoverable but unavailable capability has the same safe non-invocable reason and is not offered as an executable MCP choice.
- Navigation, filtering, sorting, paging, refresh, drafts, file operations and named actions use stable semantic resources and controls rather than display text, DOM structure, selectors, pointer coordinates or animation timing.
- Web and MCP call the same access, validation and owning operation services. MCP does not introduce a second save engine, action runner, permission evaluator or schema-free record endpoint.
- Live-interface pairing is explicit, visible, expiring and immediately revocable. State-changing control supplies the expected semantic-state or draft revision and cannot overwrite a person's newer work.
- MCP authorization is audience-bound, client-bound and limited to the current Vortex account/application grants. Invalid origin, issuer, audience, client, revision or declared transport metadata fails before an application operation.
- Vortex supplies no embedded model, sampling request, model credential or autonomous decision loop. External clients choose how to use the permission-filtered resources and tools.

<a id="performance-measurement"></a>

## Performance behavior

Any performance claim states the hardware class, network profile, dataset size, cache state, region, percentile and measured action so the claim has a concrete meaning. Baselines and sustained regressions belong to the [performance data contract](appendices/data-contracts.md#performance-measurements) and an owned implementation issue.

Performance is an operational goal, not a development completion gate. Performance pressure never weakens access, correctness, integrity, privacy or accessibility, and a sequential query plan by itself is not a functional failure.

## Phase 6 outcome

An authorized person can open an installed application whose navigation, pages, fields, forms and actions come from published definitions, see real permitted records, create and edit a record, invoke a declared action and see its result in the UI. Theme and page states are included. A hardcoded demonstration screen or static designer mockup does not satisfy this outcome.

The visual designer, full durable workflow catalog, files/search, federation and MCP continue in their later phases. Their requirements remain in the owning specification and issues.

Contract/page work uses nested slots, safe property types, exact related contexts, revision-safe form state and semantic operations before visual authoring consumes it. Phase 6 implements the available record/query/form/rendering path. Later complete-application work adds workflows, files, connections, sharing and MCP only after their owning engines exist; unavailable later capability is represented honestly rather than by a successful stub.
