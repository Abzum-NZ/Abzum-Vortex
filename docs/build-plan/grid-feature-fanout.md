# Data grid feature fan-out (#3015, after core C3)

This manifest is for workers who move the remaining Records table grid features onto the one feature definition contract. Each task is self-contained: follow it without other context. Read `AGENTS.md` and `docs/build-plan/grid-core-design.md` first.

## The contract (what "on the contract" means)

A grid feature is declared once, in its definition file under `packages/platform/src/definition/application-composition/records-table-features/<feature>.ts`. The definition object (`recordsTable…Feature`, typed `RecordsTableFeatureDefinition<Settings, "<key>">`, see `shared.ts`) holds:

| Part | Field | State after C3 |
|---|---|---|
| Key, read-contract property, label, description | `key`, `property`, `label`, `description` | done for every feature |
| Setting group with the defaults (Puck `defaultProps` and the Table release's `features` group are assembled from it) | `settings` (`featureSettings`) | done for every feature |
| Refusals and their sentences (the validation catalogue lists them from here) | `refusals` | done for every feature |
| Board behaviour | `onBoard`, optional `boardCheck` | done for every feature |
| Rules against the table and the other features | optional `conflicts` | done for every feature |
| Check against the bound query | `check(state, facts, context)` | done for every feature |
| Events its controls raise | optional `events` | done for every feature |
| The viewer's projection part | `project(state, context)` | done for search, column filters, pinning and totals; **open for the rest** |
| The strict viewer projection wire contract | `projectionSchema` | done for every table projection; Board keeps its separate payload |
| UI view (lazy chunk, extension points, row panel) | entry in `gridFeatureViews`, `packages/ui/src/display/grid-features/registry.tsx` | done for every feature (keyed by the definition object) |
| Studio panel (editor, start settings) | entry in `studioGridFeatures`, `packages/ui/src/studio/grid-features/index.ts` | done for every feature (keyed by the definition object) |

The guard rule `grid-feature-definition` (blocking; `tooling/guard/config.ts`) enforces the following:
- every feature has `featureSettings` whose default turns it off;
- every refusal code in `recordsTableFeatureRefusalCodes` has exactly one declared sentence;
- `featureNotPossible` names one of its file's own refusals;
- no object or array in the grid code lists three or more feature keys (a second registry).

The projection wire schema is assembled from each definition's typed `projectionSchema` under its `property`, with no `grid-feature-definition` allowance. Shared filter fields live with Column filters; Inline editing owns the cell-editor schema also used by Row editing. Board keeps its separate payload and borrows the same filter-field and formatting schemas.

**Proof features, fully on the contract:** sort/filter (Search, Column filters), Column pinning, Footer totals. Use them as the pattern:
- `search.ts`, `column-filters.ts` and `pinning.ts` each have `project`.
- `totals.ts` has `project` and `conflicts` (Pivot).
- `pages/records-table-features/index.ts` calls `definition.project`.
- The UI gates pinning by the viewer's projection (`table.tsx`, `table-layout.ts`, `table-grid.tsx`), not the settings contract.
- `pages/records-table-features/totals.ts` no longer repeats the Board/Pivot gate.

## How to move one feature's projection (steps every feature task uses)

1. In `packages/platform/src/pages/records-table-features/index.ts`, `projectRecordsTableFeatures`, find the code that builds the feature's part (line references below are for main after C3 merged; search for the property name if they moved).
2. Add `project: (state, context) => …` to the feature's definition and move that code into it. Return `undefined` when the feature is off for the viewer. If it needs inputs `GridFeatureProjectionContext` does not carry, add them to that type (`shared.ts`). The available inputs are `rows`, `editors`, `contract.columns`, `contract.rowBehaviours`, `conditionalFormatting`, `pivotView`, `fieldLabels` and `exportAllowed`, which already reach `projectRecordsTableFeatures`. Pass them from the `context` object built there, and keep the type isomorphic: only plain data and functions, no server imports.
3. Delete the feature's inline code and its spread from the `projection` object. The `declared` loop adds the part under `definition.property`.
4. Remove any runtime gate that repeats a publication refusal. Publication refuses every combination the definition's `conflicts` and `check` refuse, so the projection never re-checks one.
5. Run `pnpm typecheck`, `pnpm guard` and `pnpm lint`, then walk the feature in the app as owner and as a restricted member, with screenshots in the PR.

Acceptance for every feature task:
- the feature's part of the projection is identical for the same read: before/after JSON of the table payload for owner and member on a page that enables it;
- no new key literal outside its definition;
- guard 0 blocking.

## Feature tasks

| # | Feature (key) | Projection code to move (`pages/records-table-features/index.ts`) | Extra steps | Issues | Complexity |
|---|---|---|---|---|---|
| F1 | Saved views (`saved_views`) | `savedViews` (l.195) | Studio `recordsTableSettingMaximumItems("features", "saved_views", …)` in `studio/grid-features/saved-views.tsx` should take the definition (`recordsTableSavedViewsFeature.settings`) instead of key strings. | none open | simple |
| F2 | Bulk actions (`bulk_actions`) | `recordsTableBulkActions` (l.122–124), `bulkActions` (l.196) | `bulk-run.ts` reads `contract.features.bulkActions` directly; keep it, but name the feature through the definition where it names the key. | #3528 (select-all count while searching) | medium |
| F3 | Inline editing (`inline_edit`) | `recordsTableEditableFields` (l.95–100), the `inlineEdit` spread | `flow-dispatch.ts` l.114/152/161 spell `"inline_edit"` as the event and feature name: take `recordsTableInlineEditFeature.key` and the event from its `events`. `ui/display/grid-features/inline-edit.tsx` l.224 likewise. | — | medium |
| F4 | Row editing (`row_edit`) | `rowFields` (l.200), the `rowEdit` spread (l.270–274) | `flow-dispatch.ts` l.115/152/153/282 and `ui/display/grid-features/row-editor.tsx` l.228/236/287 spell `"row_edit"`: use the definition. | #3535 (restricted side sheet) | medium |
| F5 | Row actions (`row_actions`) | `recordsTableRowActionsProjection` (l.131–160), the `rowActions` spread | Keep the `events: { row_action: {} }` gate; the guard checks it. | #3538 (part) | medium |
| F6 | Related records (`master_detail`) | the `masterDetail` spread | `pages/records-table-features/master-detail.ts` l.145 spells the key. | #3534 | simple |
| F7 | Tree (`tree`) | the `tree` spread (parent link readable) | none | #3532 | simple |
| F8 | Group by (`grouping`) | `grouping` (l.226–239), the spread (needs `fieldLabels`) | `pages/records-table-features/grouping.ts` | #3537 | medium |
| F9 | Formatting (`conditional_formatting`) | the `conditionalFormatting` spread (needs the evaluated `conditionalFormatting` input) | Studio `recordsTableSettingMaximumItems("features", "conditional_formatting", …)` should take the definition. | #3538 (part) | medium |
| F10 | Pivot (`pivot`) | `pivot` (l.205–224), the spread (needs `pivotView`) | `pages/records-table-features/pivot.ts` l.134/251/310/369/391 and `ui/display/grid-features/pivot.tsx` l.58 spell the key: use the definition. | #3533 | medium |
| F11 | Export (`export`) | the `export` spread (needs `exportAllowed`, `contract.columns`) | `pages/records-table-features/export.ts` l.92/99 and `record-type-access.ts` l.12/109 spell `"export"` (the action and the key): separate the standard action name from the feature key. | #3529, #3545 | medium |
| F12 | Spreadsheet controls (`spreadsheet`) | `statusBarFields`, `batchEditable`, paste/fill/undo (l.242–260), the spread (l.276–300) | The projection reads the inline edit state: pass `context.features`, or project after Inline editing. | #3525 | hard |
| F13 | Board (`board`) | not projected: the board has its own payload (`ui/display/board-payload.ts`) | Studio `recordsTableSettingMaximumItems("features", "board", "totals")` should take the definition. `ui/display/grid-features/registry.tsx` `viewLoaders` names `board`: key it by `recordsTableBoardFeature`. | #3538 (part) | medium |

## Platform tasks

| # | Task | Steps | Acceptance | Complexity |
|---|---|---|---|---|
| P | Projection wire schema | Move each feature's Zod part of `recordsTableFeatureProjectionSchema` (`pages/records-table-feature-projection.ts`) into its definition as `projectionSchema`. Assemble the schema from typed parts, one `definition.property` each, so `RecordsTableFeatureProjection` keeps its exact type. Move the column filter field schemas into `column-filters.ts` (they depend only on `recordsTableFilterKinds` and the identifier schemas). Remove the `guard-allow: grid-feature-definition` on the schema once no literal list remains. | `projected-data.ts` and `projected-grid-features.ts` parse the same payloads; the guard reports no allowance for this rule. | hard |
| S | Summary query modes | `run_module_query_summary` still switches on hidden keys of its user-input parameter (`boardSummary`, `grouping`, `pivot`, `groupLimit`, `totals`). Split it the way C1 split `run_module_query`: one typed function per mode over shared helpers, one migration (version reserved by the coordinator), callers in `queries/protected-query-summary.ts` in the same PR. Compare old and new outputs on a lane for every mode and persona before dropping the old function (see the C1 PR for the method). | The comparison is byte-identical; `pnpm guard` passes. | hard |
| R | Remaining grid code that names features by key | After F1–F13, search the grid folders for feature keys used as strings (`rg '"(saved_views\|bulk_actions\|inline_edit\|row_edit\|row_actions\|master_detail\|conditional_formatting)"' packages`) and route each through its definition. Do not add or extend guard rules (owner decision). | No feature-key literals outside their definitions in grid code; guard 0 blocking. | simple |
