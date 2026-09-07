# Registered block library and runtime rendering

Task: [#66](https://github.com/Abzum-NZ/Abzum-Vortex/issues/66). **Blocked by:** [#249](https://github.com/Abzum-NZ/Abzum-Vortex/issues/249), [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250). No App Designer dependency.

## What will be built

1. Deliver the generic block families in the [page specification](../specification/07-applications-pages-and-themes.md) as platform-shipped implementations and immutable versioned registrations. Applications configure them; customers do not upload executable components.
2. Registrations declare discovery metadata, typed settings/defaults, accessible-name requirements, named slots/permitted children, access/layout semantics, responsive/height capabilities and exact dependency evidence. Use the same contracts for file-authored pages, runtime rendering and later palettes/inspectors.
3. Render validated page composition without Puck or a visual editor. Use schema-declared slot traversal, deterministic breakpoint inheritance and content-driven sizing. Expose grid/height settings only where declared and appropriate; do not infer slots from arbitrary arrays.
4. Declare stable typed component events and context for load, refresh, filter, sort, paging, selection, actions and forms. Components invoke [#250](https://github.com/Abzum-NZ/Abzum-Vortex/issues/250) bindings and their owning engines; no business query/save code or hardcoded example data.
5. Adapt useful generic visuals from [Fluid](fluid-integration-map.md). Actual palette/search/inspector/canvas controls belong to [#65](https://github.com/Abzum-NZ/Abzum-Vortex/issues/65) and consume these registrations later.

## Acceptance criteria

- [ ] File-authored layout, data-display and interactive block registrations render through one runtime; supported page types require no designer state.
- [ ] A new platform block registers end to end, while existing pages keep exact versions and behaviour.
- [ ] Unknown/incompatible properties, invalid nesting, missing registration metadata and unsafe values refuse through the same validation used for later editing.
- [ ] Content-driven blocks work without arbitrary fixed-height/grid requirements; accessible names validate after defaults.
- [ ] Data/action events expose stable semantic controls; real execution stays with query/form/flow owners.
- [ ] Runtime desktop/tablet/phone screenshots and keyboard evidence pass. Palette/inspector screenshots are explicitly owned by #65, not a prerequisite here.
- [ ] Independent review and repository checks confirm business-neutral implementations and no second registry/renderer.
