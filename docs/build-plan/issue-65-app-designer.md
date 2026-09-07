# App Designer and page/flow canvas integration

Task: [#65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65). Visual authoring only, after the [engine-first application proof](engine-first-application-delivery.md) and completed [prototype #323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323).

**Blocked by:** [#327](https://github.com/Abzum-NZ/Abzum-Vortex/issues/327), [#323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323), [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64), [#69](https://github.com/Abzum-NZ/Abzum-Vortex/issues/69), [#70](https://github.com/Abzum-NZ/Abzum-Vortex/issues/70), [#71](https://github.com/Abzum-NZ/Abzum-Vortex/issues/71).

## Outcome

People and agents build the same applications already proven from files. The App Designer edits the existing revisioned definitions and calls existing protected draft, publication, installation and runtime operations. It implements no separate page engine, renderer, record save path, workflow interpreter or permission store.

## What will be built

1. Application-wide navigation: Application, Modules, Pages, Navigation, Frontend flows, Background workflows, Roles & access, Connections and Appearance. Keep organisation, application, draft revision and current selection visible. [Module editor #52](https://github.com/Abzum-NZ/Abzum-Vortex/issues/52) consumes this workspace; its absence does not block building the workspace itself.
2. Contextual searchable palettes, central editing canvas and right-hand inspector matching the retained prototype. Create an application from blank through the existing services, then edit its composition, navigation, pages and behaviours. Exact versions are visible during release/install review; mutable labels never determine permanent identity.
3. Adapt Puck for pages behind the Vortex adapter and React Flow for node graphs. Private editor state never becomes a published contract. Reuse the [Fluid file/capability map](fluid-integration-map.md), checking licence, supported dependencies and accessibility; exclude prototype persistence, sample records, application-specific defaults and raw save/publish/MCP paths.
4. Drag, resize, order, nest and configure registered page components with named slots and deterministic responsive inheritance. Palette discovery and property controls come from the [registered library #66](https://github.com/Abzum-NZ/Abzum-Vortex/issues/66), not a second static catalogue. Preserve every guided-form step and validate ownership/nesting without silently discarding or relocating content.
5. Edit component Action/Data bindings through one Frontend Rule Designer. Drag nodes, connect labelled ports, configure conditions/variables/forms and return to the same page selection. [#58](https://github.com/Abzum-NZ/Abzum-Vortex/issues/58) owns execution; [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250) owns bindings. Positions affect presentation only. Current/specified/System settings never create execution authority; managed-flow internals stay private.
6. Expose preview, errors, draft conflicts, history, restore, publication and separate install/upgrade controls using [#73](https://github.com/Abzum-NZ/Abzum-Vortex/issues/73) and [#64](https://github.com/Abzum-NZ/Abzum-Vortex/issues/64). Display real readiness and partial/pending outcomes, not simulated success. Reuse the ordinary IAM journey for grants; no competing assignment form.
7. Provide equivalent keyboard and semantic authoring operations for every meaningful control. [MCP #200](https://github.com/Abzum-NZ/Abzum-Vortex/issues/200) uses the same protected operations and definition revisions; pointer coordinates, CSS selectors and Puck internals are not its required authoring API.

## Acceptance criteria

- [ ] The complete file-defined application proof passed before production designer implementation begins; retained prototype completion follows that engine proof.
- [ ] Create, edit, save/reopen, validate, preview, publish, deliberately install/upgrade and restore an application without a separate representation or engine.
- [ ] Designer-authored definitions pass the same fixture/reference and real application scenarios as file-authored definitions. A change requires no example-specific core code.
- [ ] Page/flow selection, slot ownership, typed settings and semantic identities round-trip without loss. Illegal composition and stale edits produce useful errors.
- [ ] Drag/click/keyboard/semantic operations have matching outcomes. Desktop/tablet/phone, focus, reduced motion and readable labels are verified with screenshots.
- [ ] Managed graphs and protected fields/operations are not disclosed; changing a Run as setting does not grant that authority. Record edits do not mutate page-definition JSON.
- [ ] The real renderer supplies preview and installed page behaviour; this task does not claim mocked workflow or connection execution.
- [ ] Independent review checks the actual implementation, complete authoring capability map, generic core and shared UI/MCP boundaries before closure.

## References

- [Application specification](../specification/07-applications-pages-and-themes.md)
- [Page contracts](../specification/appendices/page-builder-contracts.md)
- [Frontend Rule Designer](../specification/appendices/frontend-rule-designer.md)
- [HTML prototype scope](app-designer-html-prototype.md)
