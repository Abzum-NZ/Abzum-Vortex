# Fluid builder reuse and Vortex integration

[Current roadmap](README.md) · [Architecture review](architecture-review-2026-09-21.md) · [Page-builder contracts](../specification/appendices/page-builder-contracts.md) · [Frontend flows](../specification/appendices/frontend-rule-designer.md)

The September 2026 inspection identified useful interface patterns in the separate Fluid working tree. That source included uncommitted content, so its base commit did not identify the full inspected prototype. Inspect the actual files and asset/licence provenance before copying them. This document authorizes no changes to that separate repository.

Current issue descriptions govern scope and pickup. Completion is implementation plus independent code review; no tests, hosted checks, screenshots as proof or compatibility layers are required.

## Reuse decisions

| Capability | Vortex implementation |
| --- | --- |
| Canvas, selection, undo/redo and inspector | #65 adapts the interaction layout. #249 isolates Puck state behind the Vortex-owned adapter and current revisioned Application representation. |
| Palette and settings | #66 registers the fixed generic block catalogue; #65 derives searchable categories and controls. No business-specific demo catalogue in core. |
| Application structure | #64 owns structure/lifecycle; editor changes use permanent identities and protected revision-checked draft operations. |
| Shells, outlets and guided forms | #249 declares typed slots and ordered placements. One schema-declared traversal serves adapters. Empty list properties are not slots; preserve each guided step independently. |
| Shell locks | The UI reflects restrictions; protected server operations enforce them, including root insertions. Client flags do not grant authority. #69 applies runtime filtering. |
| Save, preview, publish and install | Save changes an expected draft revision; preview uses that exact draft; publish creates an immutable release; install explicitly adopts a release. Reuse Definition and Application owners. |
| Persistence | Use Definition storage/history/conflicts. Do not copy filesystem writes, seed-on-error recovery or silent replacement. |
| Themes and navigation | One inherited Application owner, consumed by #64/#71. Do not copy theme or navigation into every page. |
| Data blocks, forms, filters and buttons | #250 binds component events to Application flows. Registered nodes call authorised Query/Record operations through #58/#67/#68. No hidden direct save route. |
| Durable work | Later protected Workflow operations accept intents and dispatch after commit. UI code has no Kestra credentials. |
| Motion and refresh | Preserve shell, focus and unsaved input. Refresh affected regions only; support reduced motion. Scope private state to account, organisation, Application and revision. |
| MCP and examples | #200 uses the same semantic protected operations. Do not copy private editor APIs or prototype MCP packages into core. Demo Applications remain ordinary definitions. |

## Composition and rendering

The editor uses protected draft operations through the Vortex adapter. Validation checks exact blocks, slots, settings and bindings. The same current Application release drives runtime rendering and semantic descriptions. Keep interactive editing client-side and protected reads/mutations server-side; page components do not bypass services with direct database calls.

Refuse unsupported edits, duplicate identities, orphaned content and invalid shell relationships visibly. Never relocate or discard content during extraction. Shell removal and application deletion check their actual dependants. Responsive rendering honours breakpoint inheritance, ordering, sizing and declared height capabilities.

Buttons, submissions and record gestures bind to Application-owned flows. Editable simple defaults and custom flows share the inspector/designer. Field editing and presentation remain ordinary generic component behaviour. Render and prefetch do not start writes.

## Authoring layout

Use the [retained App Designer prototype](app-designer-html-prototype.md): persistent application navigation at far left, contextual palette, central page/flow canvas and selection inspector. Explicit labelled ports define flow routes. Pointer, keyboard and semantic edits share protected operations. Application Appearance does not change editor chrome.

#249/#250/#64/#66 provide the composition, binding, application and block foundations; the phase-6 application demonstrates those functional paths; #323/#65 provide the later authoring experience. The current roadmap owns detailed dependencies. Headless composition and runtime do not wait for the visual editor.
