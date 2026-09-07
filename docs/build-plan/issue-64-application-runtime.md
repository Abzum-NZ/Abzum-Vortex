# Application engine, installation and runtime assembly

Task: [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64). This is engine work, not App Designer implementation. Follow [engine-first delivery](engine-first-application-delivery.md).

**Blocked by:** [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40), [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58), [#67](https://github.com/Abzum-NZ/Abzum-Vortex/issues/67), [#68](https://github.com/Abzum-NZ/Abzum-Vortex/issues/68), [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73).

## What will be built

1. Assemble an application from an exact published definition and module bindings. Resolve its launcher, landing page, stable routes, ordered navigation, pages and registered blocks without requiring a visual editor or Puck state. Labels may change without changing route/permanent identities; phone navigation uses the same tree as desktop.
2. Wire the shared renderer and semantic page/control projection to the same installed artifact. Reuse the query, form/action, flow, Access and theme owners. No application-name checks, sample rows in core, parallel renderer or page-specific save handler.
3. Implement explicit install/upgrade/withdrawal and readiness through the protected administration boundary from [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40), never an owner connection or direct raw registry writer. Publication alone changes no installation. Register exact permission declarations and role templates without granting account or Group access.
4. Preserve organisation-owned roles, compatible shared-module suppliers and separate application contexts. Upgrade/removal/withdrawal uses the existing same-transaction catalogue and Access-version composition. Changed, removed/readded or reactivated authority needs the established fresh IAM acceptance; custom roles are not overwritten and old grants do not silently resume.
5. Preserve the permanent management-application requirement. Complete governed setup must include both management/delegation and operating rights for the nominated account; a role or application change cannot strand the final permanent steward. Reuse exact published references and [IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267), never a name-based exception or new grant route. Where the live IAM binding is not delivered, report that operation unavailable rather than fabricate approval.
6. Provide the installation extension consumed by [workflow registration #76](https://github.com/Abzum-NZ/Abzum-Vortex/issues/76). Required workflow registration must be verified before an application is fully ready; failed upgrades preserve the previous active release. The extension does not claim the later executor is already built and creates no reverse dependency on it.
7. Expose the same protected lifecycle operations to non-editor callers and later designer/MCP adapters. Application Roles & access authoring links to ordinary IAM; assignment mutations never become editable application records.

## Acceptance criteria

- [ ] A checked-in application definition is validated/published through [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73), explicitly installed, launched and rendered without opening the App Designer.
- [ ] Its navigation, page components, typed query, form/action and frontend flow execute through real owning services. The rendered page and semantic controls identify the same installed artifact.
- [ ] A changed definition can be published without changing the current installation; explicit upgrade changes runtime behaviour. Withdrawal refuses new entry and preserves another compatible module supplier where applicable.
- [ ] Actual restricted runtime/request connections prove authorised success, wrong organisation/application/version and missing-authority refusal, stale changes and rollback. Registration creates no automatic assignments.
- [ ] Two identically named applications remain distinct; a custom organisation role can select exact permissions across them without label-based authority.
- [ ] Missing dependencies, undelivered workflow/connection capabilities and incomplete governed setup are visible, not reported as successful installation.
- [ ] Capture desktop/phone runtime screenshots and a file-defined application walkthrough. Independent review covers the actual engine and full local/hosted evidence.

This establishes the base application runtime; it does not replace the complete multi-application/workflow/connection proof in the [engine-first plan](engine-first-application-delivery.md). All visual navigation editing, palettes, inspectors and canvas authoring move to [#65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65). Module editing remains [#52](https://github.com/Abzum-NZ/Abzum-Vortex/issues/52). Runtime access/theme extensions remain [#69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69) and [#71](https://github.com/Abzum-NZ/Abzum-Vortex/issues/71).

## References

- [Application specification](../specification/07-applications-pages-and-themes.md)
- [Access model](../specification/04-access-and-permissions.md)
- [Frontend flow architecture](../specification/appendices/frontend-rule-designer.md)
- [Page contracts](../specification/appendices/page-builder-contracts.md)
