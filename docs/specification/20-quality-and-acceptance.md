# 20. Implementation quality and code-review acceptance

[Specification index](README.md) · [Development delivery](18-delivery-and-testing.md)

## Definition of complete

A behaviour change is complete when its functionality is implemented, a separate code review confirms the acceptance criteria, and the affected pages are walked through in the running app on a freshly reset local database. Pull requests that change what users see include screenshots. Completion describes implemented code, not production readiness.

## Functional quality

Visible functionality implements [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) Level AA. Any platform limitation has a documented remediation plan.

Review behaviour against the owning specification:

- Organisation scope and current account/role permissions are enforced by the owning service on each protected operation. A page hiding a control is not authorization.
- Rows, fields, files, search results, totals, subscriptions, caches and errors expose only permitted content. Switching organisation clears the old context; tenant administration does not imply child-organisation data access.
- Atomic operations keep values, relationships, totals, activity and events consistent. Revision checks refuse stale writes. Duplicate-protection keys do not create repeated effects.
- Published definitions have explicit identities and selected versions. Draft save, publication and activation remain separate user operations. There is one current contract representation; legacy readers and backward-compatibility layers are not required.
- UI components have keyboard and focus handling, readable errors, component-scoped loading, responsive layouts and reduced-motion behavior. Late responses cannot overwrite a newer selection or expose withdrawn content.
- Definition-led applications use generic engines and ordinary definitions. Business names, approval policies and special cases do not enter core runtime code.
- Frontend flows use typed inputs and variables, explicit operation calls, and their fixed `runAs`. Rendering, prefetching and retries do not manufacture writes. The original human remains attributable.
- A presentation-only flow may finish without saving. Each protected write owns its transaction. A later sequential failure preserves earlier confirmed commits and accurately reports the partial result.
- Forms, clicks, keyboard submission and record gestures use the same declared action flow. Default Save form is an explicit operation node, not a hidden component writer.
- The page and an agent acting through the page model call the same operation services. The page model does not introduce a second save engine, action runner or permission evaluator.
- File removal, privacy restrictions, legal holds, retention and restore use their owning product rules. No role or environment shortcut bypasses them.
- Secrets and private content stay out of browser bundles, safe errors and operational logs.

## Review scope

The issue's What will be built section names the owning code, inputs, outputs, dependencies and excluded work. Acceptance criteria describe observable implementation behaviour and structures a reviewer can inspect. They do not add a second implementation of the same feature or an unnecessary framework.

Use the simplest design that meets the current specification. Correct an unsuitable contract or schema at its source. Published product revisions remain useful functionality; retaining an obsolete platform serialization is not required for this new application.

<a id="organisation-separation-suite"></a>

## Organisation separation behavior

Organisation separation applies at every boundary described by [People and organisations](02-people-organisations-and-sign-in.md), [Access](04-access-and-permissions.md), [Records](06-records-and-lifecycle.md), [Files](11-files-and-attachments.md) and [runtime storage](17-runtime-storage-and-caching.md). The implementation has these required outcomes:

- An authenticated identity acts through one current organisation account and one explicit application context per request. Membership or authority in another account, tenant, organisation or application never combines with the current context.
- Record rows, relationships, calculated values, Activity, Event, files, live updates, search, reports, exports, caches and flow state remain scoped to the current permitted organisation and application. Browser navigation, background work and retries cannot reuse stale scope.
- Request/runtime roles have only their declared protected routes. A table owner, migration identity, service credential, URL parameter, hidden UI state or direct helper call cannot stand in for an authorised application caller.
- Organisation switching clears account-specific server and client state. Back navigation, a late response, subscription delivery or cache entry cannot reveal content from the previous context.
- Tenant administration exposes only the hierarchy and operations explicitly granted by the tenant contract. It does not imply a child-organisation account, local administration, record access or application use.
- Identically named organisations, applications, roles, permissions and records retain distinct permanent scope. Display names and authored labels never select authority.

Application and role administration preserve scope:

- Registering or publishing an application assigns no access. Explicit installation/activation selects its exact release; new or broadened permissions require an authorised assignment, while removed permission or withdrawal becomes ineffective immediately.
- One organisation role may contain permissions from several applications without merging their application scopes. Application administration grants neither organisation administration nor another application's authority.
- Direct-account and Group assignments use the same protected organisation-role operations. Foreign account, Group, role, application or permission identities are refused.
- At least one effective direct permanent organisation steward remains. An expiring or Group-derived delegate cannot silently replace that invariant.

## Roles and Groups

The [Roles and Groups contract](appendices/groups-and-privileged-access.md) governs assignments. A role defines exact permissions; an account receives them through a direct or Group assignment while the assignment and all current access conditions are valid. A Group assignment gives its current members the role's accepted permissions; membership alone grants nothing else.

The [IAM application](appendices/iam-application.md) keeps requests, reviews and protected effects linked to exact organisation accounts, Groups, role and application versions, and proposal content. Editing an ordinary request or review record, substituting an approver, replaying a result or invoking a private helper cannot grant access. Immediate authorised removal remains available.

<a id="accessibility-acceptance"></a>

## Accessibility and interaction behavior

Visible functionality meets [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) Level AA unless a documented platform limitation has an owned remediation. Keyboard and focus order, readable labels and errors, contrast, zoom, supported responsive layouts and reduced-motion behavior are part of the implementation.

Normal, empty, loading, validation, refused, conflict, failure and recovery states preserve the same meaning at supported widths. Internal navigation keeps the application shell and unrelated unsaved state intact. A slow route or component supplies local progress, and a refresh changes only affected components and dependent totals.

Motion uses the central semantic tokens and remains interruptible. A late response or transition for record A cannot flash, regain focus or replace state after the user has moved to record B. Reduced-motion mode communicates the same state change without depending on animation.

<a id="page-model-parity-acceptance"></a>

## Page and page-model parity

The page model projects the published [semantic interface map](07-applications-pages-and-themes.md#semantic-interface-map). For the same identity, organisation account, application revision and access revision, the page and an agent acting through it expose the same permitted navigation, fields, choices, drafts, files, actions, Studio controls and administration meaning.

- View-refused content is disclosed by neither surface. A discoverable but unavailable capability has the same safe non-invocable reason and is not offered as an executable tool choice.
- Navigation, filtering, sorting, paging, refresh, drafts, file operations and named actions use stable semantic resources and controls rather than display text, DOM structure, selectors, pointer coordinates or animation timing.
- The page and the page model call the same access, validation and owning operation services. The page model does not introduce a second save engine, action runner, permission evaluator or schema-free record endpoint.
- A state-changing control supplies the expected semantic-state or draft revision and cannot overwrite a person's newer work.
- Vortex supplies no embedded model, sampling request, model credential or autonomous decision loop. An agent acts only through the page's permission-filtered tools.

<a id="performance-measurement"></a>

## Performance behavior

Any performance claim states the hardware class, network profile, dataset size, cache state, region, percentile and measured action so the claim has a concrete meaning. Baselines and sustained regressions belong to the [performance data contract](appendices/data-contracts.md#performance-measurements) and an owned implementation issue.

Performance is an operational goal, not a development completion gate. Performance pressure never weakens access, correctness, integrity, privacy or accessibility, and a sequential query plan by itself is not a functional failure.

## Current outcome

The deliverable is an installed, definition-led application: a person can sign in, open it, navigate its pages, read permitted records, create and edit records, run a declared action and see the application's theme and page states. One page runner executes page segments and gated server segments; the one record writer applies every record save; and the one Puck config renders every page from its definition.
