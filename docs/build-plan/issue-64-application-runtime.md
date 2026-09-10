# Application engine, installation and runtime assembly

Task: [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64). This is engine work, not App Designer implementation. Follow [engine-first delivery](engine-first-application-delivery.md).

**Prerequisites:** [#39](https://github.com/Abzum-NZ/Abzum-Vortex/issues/39), completed [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40), [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58), [#67](https://github.com/Abzum-NZ/Abzum-Vortex/issues/67), [#68](https://github.com/Abzum-NZ/Abzum-Vortex/issues/68), [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73).

## What will be built

1. Assemble an application from an exact published definition and module bindings. Resolve its launcher, landing page, stable routes, ordered navigation, pages and registered blocks without requiring a visual editor or Puck state. Labels may change without changing route/permanent identities; phone navigation uses the same tree as desktop.
2. Wire the shared renderer and semantic page/control projection to the same installed artifact. Reuse the query, form/action, flow, Access and theme owners. No application-name checks, sample rows in core, parallel renderer or page-specific save handler.
3. Implement explicit install/upgrade/withdrawal and readiness through the concrete lifecycle boundary owned here, reusing [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40)'s governance-first transaction pattern and existing private Access writer. Never give the application an owner connection or direct raw registry access. Publication alone changes no installation. Register exact permission declarations and role templates without granting account or Group access.
4. Preserve organisation-owned roles, compatible shared-module suppliers and separate application contexts. Upgrade/removal/withdrawal uses the existing same-transaction catalogue and Access-version composition. Changed, removed/readded or reactivated authority needs the established fresh IAM acceptance; custom roles are not overwritten and old grants do not silently resume.
5. Preserve the permanent management-application requirement. Complete governed setup must include both management/delegation and operating rights for the nominated account; a role or application change cannot strand the final permanent steward. Reuse exact published references and [IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267), never a name-based exception or new grant route. Where the live IAM binding is not delivered, report that operation unavailable rather than fabricate approval.
6. Provide the installation extension consumed by [workflow registration #76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76). Required workflow registration must be verified before an application is fully ready; failed upgrades preserve the previous active release. The extension does not claim the later executor is already built and creates no reverse dependency on it.
7. Expose the same protected lifecycle operations to non-editor callers and later designer/MCP adapters. Application Roles & access authoring links to ordinary IAM; assignment mutations never become editable application records.

#64 owns the permanent application-lifecycle operation contract, its platform permission registration and protected caller binding, including withdrawal. The fixed command targets the exact application root; the permission is organisation-scoped so installation does not require an already-active application. It is not an arbitrary permission selected from the installed application, and registering it grants nobody access; governed assignment remains owned by IAM. It also owns the concrete locked affected-scope and atomic Activity composition around the existing private Access coordinator, using #40's protected transaction pattern. Role-management and assignment-management permissions cannot substitute for installation authority. Follow the [reviewed consumer handoff](access-consumer-handoffs.md#application-runtime-acceptance-additions): #40 must not invent this task's missing permission or accept unverified permission evidence. Withdrawal uses the exact current application-context permission catalogue as the affected before scope and preserves supplier/steward safeguards. This division creates no reverse dependency.

### Installation permission delivered with the storage engine

Co-deliver this task's lifecycle permission/caller slice with [Module installation #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43)
and [Record provisioning #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45).
Do not make initial provisioning wait for this whole renderer task or add a
reverse dependency on it. The remaining runtime prerequisites above still govern
complete application rendering and readiness.

The additive platform permission `platform.organization.applications.manage`
allows invoking application lifecycle operations within the selected organisation.
It does not grant use of business records, role assignment or unrestricted
catalogue mutation. Each fixed operation binds the exact application root,
published release and expected binding/registration revision, and separately
checks existing delegated-management authority over its locked complete before
and after application-permission scope. New installation cannot invent continuity
for not-yet-registered permissions; use existing organisation-catalogue delegation
where bounded delegation cannot cover that prospective scope. Recheck these
requirements before provisioning and again before activation.

Ship the new permission in immutable platform catalogue `1.1.0`, retaining the
historical `1.0.0` and display-only `1.0.1` evidence. Adopt shipped revisions through
one owner-only, expected-revision operation using trusted version/fingerprint
evidence, not caller-authored permission entries or a special command per future
version. Registration adds no role membership, assignment or implicit grant.

The permanent-steward requirement remains the original thirteen exact management
permission identities and meanings plus the existing management-application
requirement. Do not equate that minimum with every future catalogue entry or
invalidate a steward merely because a new permission is published. Existing
delegation permits governance of the new permission without granting its use.

## Acceptance criteria

- [ ] Consume the page adapter's resolved, permission-filtered shell and page
      composition, including each guided step and responsive order. Do not attach
      an unfiltered shell or page subtree again after projection. Preserve allowed
      empty runtime layouts. Actual queries, forms and operations still use their
      owning services; resolved presentation is not data or operation authority.

- [ ] Supply the real trusted application-service context and installed exact
      release selector to the [page adapter #38](issue-38-page-capability-projection.md).
      Reuse the existing Definition consumer reader; its system-context release
      read and the human Access projection use distinct short transactions bound
      to the same exact immutable artifact and server correlation. Never mint
      system authority from human input or reuse #30's structural operator.
      Earlier injected fixture contexts prove storage behavior, not this deployed
      service boundary. Consume V2 only after #249 extends the same stored reader.

- [ ] A checked-in application definition is validated/published through [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73), explicitly installed, launched and rendered without opening the App Designer.
- [ ] Its navigation, page components, typed query, form/action and frontend flow execute through real owning services. The rendered page and semantic controls identify the same installed artifact.
- [ ] A changed definition can be published without changing the current installation; explicit upgrade changes runtime behaviour. Withdrawal refuses new entry and preserves another compatible module supplier where applicable.
- [ ] Actual restricted runtime/request connections prove authorised success, wrong organisation/application/version and missing-authority refusal, stale changes and rollback. Registration creates no automatic assignments.
- [ ] The exact declared lifecycle permission, locked full affected scope, existing Access writer and Activity compose atomically; caller-selected permissions, scope or owner credentials cannot bypass this boundary. Required IAM acceptance is not fabricated.
- [ ] Two identically named applications remain distinct; a custom organisation role can select exact permissions across them without label-based authority.
- [ ] Missing dependencies, undelivered workflow/connection capabilities and incomplete governed setup are visible, not reported as successful installation.
- [ ] Capture desktop/phone runtime screenshots and a file-defined application walkthrough. Independent review covers the actual engine and full local/hosted evidence.

This establishes the base application runtime; it does not replace the complete multi-application/workflow/connection proof in the [engine-first plan](engine-first-application-delivery.md). All visual navigation editing, palettes, inspectors and canvas authoring move to [#65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65). Module editing remains [#52](https://github.com/Abzum-NZ/Abzum-Vortex/issues/52). Runtime access/theme extensions remain [#69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69) and [#71](https://github.com/Abzum-NZ/Abzum-Vortex/issues/71).

## Set-wise page eligibility and launcher data — 9 September 2026

Before the page runtime integrates [#69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69)
and this task's rendering path, permission eligibility for a page's placements
must be resolvable set-wise: one authorised database round trip returns the
eligibility of every placement-relevant permission for the current context,
rather than one database eligibility call per placement. Where practical,
organisation scope resolution also returns the organisation display data the
launcher needs, so opening an application does not repeat a separate launcher
lookup. This is a task and specification requirement for the #69/#64
integration, not an instruction to implement caching or batching now, and it
changes no authorisation semantics.

## References

- [Application specification](../specification/07-applications-pages-and-themes.md)
- [Access model](../specification/04-access-and-permissions.md)
- [Frontend flow architecture](../specification/appendices/frontend-rule-designer.md)
- [Page contracts](../specification/appendices/page-builder-contracts.md)
