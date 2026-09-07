# Complete definition-first application engine proof

Task: [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327).

## Outcome

The complete checked-in CRM and Service Desk applications run from authored definitions before the App Designer is built. This task integrates existing engines; it creates no new engine, editor, test framework or sample-only runtime. Follow the [engine-first plan](engine-first-application-delivery.md).

## Prerequisites

[Application runtime #64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64), [runtime access #69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69), [themes #71](https://github.com/Abzum-NZ/Abzum-Vortex/issues/71), [base application proof #74](https://github.com/Abzum-NZ/Abzum-Vortex/issues/74), [durable event execution #77](https://github.com/Abzum-NZ/Abzum-Vortex/issues/77), [pipelines #85](https://github.com/Abzum-NZ/Abzum-Vortex/issues/85), [search/attachment components #96](https://github.com/Abzum-NZ/Abzum-Vortex/issues/96), [outbound connections #100](https://github.com/Abzum-NZ/Abzum-Vortex/issues/100), [inbound connections #101](https://github.com/Abzum-NZ/Abzum-Vortex/issues/101), [published interfaces #103](https://github.com/Abzum-NZ/Abzum-Vortex/issues/103), [caller contexts #104](https://github.com/Abzum-NZ/Abzum-Vortex/issues/104), [sharing grants #153](https://github.com/Abzum-NZ/Abzum-Vortex/issues/153), and [governed IAM #267](https://github.com/Abzum-NZ/Abzum-Vortex/issues/267).

## What will be built and verified

The proof also depends on [workflow run views and permitted controls #86](https://github.com/Abzum-NZ/Abzum-Vortex/issues/86) for application-facing execution status and controls.

1. Complete authored application/module files contain the exact records, fields, relationships, queries, navigation, pages, forms, actions, themes, role/permission declarations, frontend flows, background workflows, pipelines, connections and interfaces. Map every declared capability to its real executor and evidence. No missing capability is replaced by a successful mock or removed simply to pass this proof.
2. Create/validate/publish those definitions through supported non-editor services, then explicitly install exact releases in two organisations. No Designer, Puck state or browser-built draft is required. Registration grants nobody automatic access; establish permitted use through the real governed IAM operations and their generic application/workflows.
3. Open the real launcher and application routes. Render pages and semantic controls from the exact installed artifact; query records, follow relationships, submit forms and run configured frontend flows. Exercise conditions, variables, interactive forms, sequential/collect-first results and declared execution identities without bypassing viewer-safe results or permissions.
4. Register and run the declared background workflows on the existing shared Kestra instance through the Vortex boundary. Exercise declared pipeline transitions and file/search controls. Verify accepted, pending, completed and failed outcomes rather than presenting acceptance as completion.
5. Exercise real Testing outbound/inbound connections and a served published interface through their permitted caller contexts. Keep credentials in protected connection storage; no direct provider or owner-database shortcut.
6. Prove the same organisation-shared Company and Contact records appear in both applications. Prove CRM receives only the approved Case Summary fields, can perform the declared collaborative changes against the exact Service Desk source record and loses the grant route immediately on revocation. No CRM Case Summary copy is stored; source records remain authoritative. Cross-cluster federation remains a later [#254](https://github.com/Abzum-NZ/Abzum-Vortex/issues/254)/[#156](https://github.com/Abzum-NZ/Abzum-Vortex/issues/156) proof, not simulated here.
7. Prove wrong organisation, same-label/different application, denied account/action and stale changes are refused. Publish changed files while the old installation remains pinned; explicitly upgrade to change behaviour. Failed/stale upgrades preserve the prior working version. Withdrawal prevents new entry and workflow starts while retaining required history.
8. Capture exact code/fixture/release/installation references, Testing evidence, real browser screenshots and a concise end-user walkthrough. Exercise a web-independent semantic adapter against the same artifacts/operations. Obtain independent review against this entire task, not just individual engine tests.

## Acceptance criteria

- [ ] Every declared capability in both complete applications has a real executor and passing evidence; no sample-only handler or silent omission.
- [ ] The files include and exercise both module-owned and application-owned actions, including an application action bound to a module's permissions. Preserve supported singular bindings and prove same-action alternatives through the completed [record-access engine #35](issue-35-row-policy-composition.md); matching labels or ambiguous permission keys never substitute for exact references.
- [ ] Files → validation/publication → explicit installation → real browser use → upgrade/withdrawal works without a visual editor.
- [ ] Pages, data, forms, frontend/background flows, pipelines, files/search, governed access, connections and interfaces work in the declared application context.
- [ ] Shared-record identity, limited Case Summary collaboration/revocation and both organisation isolation directions pass.
- [ ] The same installed artifacts drive browser and non-editor semantic operations.
- [ ] Screenshots, walkthrough, exact Testing results and independent whole-task approval are recorded.

## What follows

Only after this proof, resume [prototype #323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323) and [App Designer #65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65). Designer/module-editor/HR-authoring proof and full authenticated [MCP #200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200) parity follow using the same definitions and operations. [Final cross-phase acceptance #254](https://github.com/Abzum-NZ/Abzum-Vortex/issues/254) retains its later designer/MCP/federation scope and consumes this proof; it cannot be a prerequisite of the designer because that would form a cycle.
