# First usable definition-led application proof

Task: [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327).

## Outcome

The checked-in CRM and Service Desk applications install and run from authored
definitions through the real Phase 4–6 engines before any App Designer work.
This proof integrates existing engines; it creates no new engine, editor or
test framework. It is deliberately the first usable definition-led proof, not
the complete capability matrix: background workflows, pipelines, files/search,
connections/interfaces, record sharing/federation, the governed IAM human
journey, MCP parity and designer evidence belong to their owning issues and to
[#254](https://github.com/Abzum-NZ/Abzum-Vortex/issues/254). Follow the
[engine-first plan](engine-first-application-delivery.md).

## Prerequisites

[Module lifecycle #43](https://github.com/Abzum-NZ/Abzum-Vortex/issues/43),
[record storage #45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45),
[protected save #47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47),
[module queries #54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54),
[application runtime #64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64)
and the [renderer checkpoint #74](https://github.com/Abzum-NZ/Abzum-Vortex/issues/74).

## What will be built and verified

1. Publish both applications' complete current definitions through supported
   non-editor services, then explicitly install and activate exact releases in
   two organisations. Permitted use may be established through the delivered
   [#40](https://github.com/Abzum-NZ/Abzum-Vortex/issues/40) protected
   assignment operations; the governed IAM human journey remains with
   [#267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267) and #254.
2. Open the real launcher and application routes. Render declared pages,
   navigation and semantic controls from the exact installed artifact.
3. Query records and save changes through the owning protected services with
   row and field enforcement, including configured before-save rules.
4. Prove the same organisation-shared Company and Contact records appear in
   both applications with no duplicate storage, and prove both organisation
   isolation directions refuse.
5. Prove publication without installation changes nothing, explicit upgrade
   changes behaviour, and failed or stale upgrades preserve the prior working
   version.
6. Record exact fixture/release/installation/code references, Testing evidence,
   real browser screenshots and a concise walkthrough; obtain independent
   review against this whole narrowed scope.

## Acceptance criteria

- [ ] Files → validation/publication → explicit installation/activation → real
      browser use → upgrade works without a visual editor.
- [ ] Rendered navigation, pages, queries, forms and saves execute through the
      real owning services and identify the same installed artifact.
- [ ] Shared Company/Contact identity and both isolation directions pass at the
      database boundary.
- [ ] Wrong organisation, same-label/different application, denied
      account/action and stale changes refuse.
- [ ] Declared capabilities outside this proof are reported honestly and
      tracked on their owning issues, never mocked as delivered.

## What follows

Only after this proof, resume [prototype #323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323)
and [App Designer #65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65).
[#254](https://github.com/Abzum-NZ/Abzum-Vortex/issues/254) consumes this proof
and owns the later workflow, file/search, connection/interface,
sharing/federation, IAM-journey, MCP and designer evidence; it cannot be a
prerequisite of the designer because that would form a cycle.
