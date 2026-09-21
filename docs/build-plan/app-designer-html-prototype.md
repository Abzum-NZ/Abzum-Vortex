# App Designer HTML prototype

Task: [#323](https://github.com/Abzum-NZ/Abzum-Vortex/issues/323). [Current roadmap](README.md) · [Architecture review](architecture-review-2026-09-21.md) · [Application specification](../specification/07-applications-pages-and-themes.md)

The retained prototype describes the authoring experience scheduled after the phase-6 definition-led application. Current issue dependencies govern pickup. Completion is the scoped implementation plus independent code review, without tests, screenshots as proof or hosted gates.

## Functional outcome

A builder can follow a clickable journey from application creation through data, pages, flows, preview and release. The prototype labels simulated outcomes and remains separate from shipping runtime code. Its demonstration content does not define business behaviour in the platform.

## Canvas and authoring

- Keep organisation, application and draft revision visible. Far-left application navigation includes Application, Modules, Pages, Navigation, Frontend flows, Background workflows, Roles & access, Connections and Appearance, with counts from the current draft.
- Use a contextual searchable component/node palette, central canvas and right-hand selection inspector. The outline, canvas and inspector share selection. Dark editor controls remain separate from the application's theme.
- Dragging, click-to-add, keyboard positioning and semantic authoring produce equivalent draft changes. Flow connections use labelled ports and explicit edges; conditions expose branch outputs. Visual position and array order do not determine routes.
- Show creation of several Modules, fields, a relationship and an exposed query. Explain shared versus application-contained data. Module and Application releases remain distinct.
- Show table, form and button composition, reorder/configuration, responsive preview and keyboard alternatives. Component Action and Data bindings open the same flow designer while preserving page context.
- Demonstrate editable Save form and Query/Return defaults, a condition, typed variable, Show form continuation, explicit write and background start. A configured data flow may read, transform, write, read again and return rows. Preview performs no effects.
- Show current-user, specified-user and scoped System configuration distinctly from permission to execute. Managed flows reveal only permitted public settings. Role assignment uses IAM rather than direct template edits.
- Show empty, loading, invalid, stale-draft, unavailable-authority, committed, partial and background-pending states. Cancelling input cannot undo an earlier committed operation.
- Demonstrate exact-draft preview, dependency validation, immutable publication and separate installation/upgrade readiness. Missing dependencies and authority remain visible; simulation never claims a real publication or installation.
- Describe equivalent protected semantic operations for capability discovery, Modules/fields/relationships, pages/slots/navigation, queries/conditions/variables/graphs/bindings, roles, connections/interfaces, validation, preview, publication and installation. Include inputs, expected revision and result; expose no secrets or private Puck state.

Retain the [prototype entry point](../prototypes/app-designer/index.html). Production editor mechanics follow the [Frontend Rule Designer](../specification/appendices/frontend-rule-designer.md) and [Fluid reuse map](fluid-integration-map.md), with accessible focus, readable labels, reduced motion and responsive layout. Actual MCP transport remains #200; prototype controls invoke no invented delivered tools.
