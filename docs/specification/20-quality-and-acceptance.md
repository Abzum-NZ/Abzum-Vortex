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

## Phase 6 outcome

An authorized person can open an installed application whose navigation, pages, fields, forms and actions come from published definitions, see real permitted records, create and edit a record, invoke a declared action and see its result in the UI. Theme and page states are included. A hardcoded demonstration screen or static designer mockup does not satisfy this outcome.

The visual designer, full durable workflow catalog, files/search, federation and MCP continue in their later phases. Their requirements remain in the owning specification and issues.
