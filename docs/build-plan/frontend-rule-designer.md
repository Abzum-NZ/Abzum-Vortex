# Frontend Rule Designer delivery

[Current roadmap](README.md) · [Architecture review](architecture-review-2026-09-21.md) · [Full specification](../specification/appendices/frontend-rule-designer.md)

Current issues own the bounded scopes and pickup order. Completion is implementation plus independent code review, with no tests, database review, hosted proof or retained obsolete formats.

## Functional model

Pages compose components and bind semantic events. One Frontend Rule Designer configures action and data flows with typed nodes, settings, input/output maps and explicit outcome edges. Quick actions edit that same graph. Save form uses a visible action node; default data loading uses Query → Return.

Configured flows may read, transform, write, read again and return data. They may collect Page Designer form input, commit at explicit nodes and later request durable work. Every owning operation is atomic; later cancellation or failure preserves earlier commits. No transaction remains open while awaiting a person or external service. Pure feedback and preview remain effect-free.

## Implementation boundaries

- Shared Rule owns the pure graph interpreter. App owns headless coordination over lower-tier protected services. Web handles typed UI/form intents. Record invokes the same pure before-save subset without importing App.
- #250 owns current-user Query/Action/Transform/Return node contracts, application-flow declarations and binding resolution before #58 implements runtime execution. Definitions follow one current source/canonical/compiler/publication path.
- The first application uses current-user execution. Later scoped identity, interactive continuation and durable handoff scopes remain separately scheduled in the current roadmap.
- Query owns authorised dataset-wide filters, ordering, aggregates and pagination. A bounded transform cannot claim to sort the complete dataset or fabricate writable record identity.
- Start flows on declared semantic events, not rendering or prefetch. Carry invocation/cause identity, suppress stale results and prevent self-caused invalidation from repeating writes. Reconcile uncertain operation outcomes before continuing; do not replay a whole graph with new branch decisions.
- Interactive continuations use the owning private draft store and exact release/node/receipt references. The server checks continuation state; a browser next-node claim is not authority. Cancel before the first write leaves business records unchanged; later cancellation reports partial completion.
- Current user, specified user and scoped System resolve through Access at each protected node. Configuration and copied definitions confer no grant. Identity-changing nodes receive separately resolved short transactions.
- Keep privileged intermediate values server-only. Returned rows, fields, counts, messages, errors, files, exports, subsequent writes and MCP results retain the invoking viewer's disclosure bounds. Activity records the effective actor and linked initiator where one exists; system work has an actual system cause rather than a fabricated human.
- Every flow has exactly one owner: the module or application release that contains it. Behaviour that must stay hidden or platform-controlled is a protected operation, and reusable platform behaviour ships as ordinary flows in system modules. Installation, copying and upgrades do not copy execution grants or silently broaden authority.
- Durable starts commit an accepted intent at the configured node, remain release-pinned and dispatch after commit. A later UI failure does not cancel accepted work. Durable waits use Workflow/Kestra rather than a second frontend scheduler.
- Public callers have no current organisation account. They cannot nominate a specified user; only explicitly public operations may use separately authorised scoped System bindings.
- UI and MCP consume the same semantic authoring, invocation, form and result operations. Page adapters expose no private editor state or privileged per-node bypass.

## Presentation

Use one graph canvas for component actions and data bindings. Preserve the selected page component when switching to a flow. Display stable ports and branch labels, typed variables, editable defaults and truthful draft/committed/partial/uncertain/background-pending outcomes. Keyboard, pointer and semantic authoring perform the same protected draft operations.

The current issue descriptions assign implementation to #54, #57, #58, #59, #64–#69, #73, #76–#83, #104, #107, #112, #115, #200, #250, #267 and the separately scheduled flow-extension tasks. #254 is cancelled; it creates no completion requirement.
