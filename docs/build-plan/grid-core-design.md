# Data grid core: design note (#3015)

Status: core builder proposal, 25 October 2026. Three stacked PRs: C1 (SQL), C2 (client state), C3 (feature contract).

## C1: one SQL function per query mode

The public functions replace `vortex_record.run_module_query` and its hidden `p_user_inputs` keys (`boardMember`, `boardColumns`, `groupMember`, `grouping`, `tree`). Each is `security definer`, owned by `vortex_record_adapter`, granted to `vortex_request` only, and has its own file in `supabase/schemas/vortex_record/`. Every public function starts with the same parameters, `(module_root_id uuid, query_id uuid, expected_release_revision bigint, input_values jsonb, requested_field_ids uuid[], requested_system_field_keys text[], filter jsonb, filterable_field_ids uuid[]`, then adds its own:

| Function | Mode parameters | Returns |
|---|---|---|
| `run_module_query_rows` | `sort jsonb, search text, sortable_field_ids uuid[], searchable_field_ids uuid[], page_size int, after jsonb, direction text` | `rows, next, opposite, fieldBounds` |
| `run_module_query_exact_rows` | `sort, search, sortable, searchable, record_ids uuid[]` (1..200; page size is the count) | the same |
| `run_module_query_board_column` | `choice_field_id uuid, board_column jsonb` (closed `{kind,value}`), `page_size, after` | the same |
| `run_module_query_board_columns` | `choice_field_id uuid, board_columns jsonb` (1..13), `page_size` | `columns[]`, `fieldBounds` |
| `run_module_query_group_members` | `sort, search, sortable, searchable, grouping jsonb` (or null), `group_values jsonb, page_size, after, direction` | rows plus `groupByFieldIds`, `groupValues` |
| `run_module_query_tree_level` | `sort, search, sortable, searchable, parent_field_id uuid, parent_record_id uuid` (null means roots), `page_size, after, direction` | rows plus `hasChildren` |

Shared owner-only helpers (`security invoker`, owner `vortex_record_adapter`, no grants) hold the protected path exactly once:

1. `module_query_open_internal(request jsonb)`: request bounds, requested and system fields, declared lists, the user sort shape, and `prepare_module_query_internal` (resolution and storage). Returns the context: query, record type, fields, storage, access predicate and parameters, readable and bound fields, search plan, and projection. Isolation, permissions and field policy come only from here.
2. `module_query_scan_plan_internal(context, sort, sort_is_user, mode_predicate, after, direction)`: sort validation over readable, sortable and stored fields; the composite index; `prepare ... 'complete'` with the preview recheck; filter pushdown; cursor validation; and the keyset segments and search prefilter. Returns the scan plan.
3. `module_query_scan_internal(plan, member jsonb, buckets int)`: the one candidate scan. It handles the 500-candidate budget, batched page decisions, the exact per-row `read_record` projection and the post-read membership test, then page capabilities, cursors and backward reversal. `member` is a closed internal value that the mode functions build; it never comes from user input. It is `all`, `choice` (one column, or classification into N buckets for the shared board scan), `group`, `tree_children` or `tree_roots`. When a membership needs batched facts (unreadable link targets, tree root parents), they are read in one lookahead pass at a time. The single-bucket page is the N=1 case of the board's shared scan, so only one accumulation path remains.

Each mode function does only its own validation: board options and the narrowed choice column, the group selector and its fields, the tree selector, and the effective sort. It then calls 1, 2 and 3, and shapes its result. No file exceeds about 700 lines. One migration (version reserved by the coordinator) creates the new functions and drops `run_module_query` with no copy. Callers change in the same PR: the five `protected-query-*.ts` files, `query-attribution.ts` and `capture-baseline.ts`. **The summary is out of C1.** `run_module_query_summary` is already a separate function and does not share this switch. Its own hidden keys (`boardSummary`, `pivot`, `totals`, `groupLimit`) go into the fan-out manifest as one SQL task.

## C2: one state owner per table

`apps/web/.../application-page-view/table-query-store.ts` defines one store per table placement (`useSyncExternalStore`). Its shape is:

`{ requested: TableQuery, shown: TableQuery, reading: boolean }`

`TableQuery` is `{ sort, filters, search, page: {number, direction, token} | last, view: {id, cleared} | null, group: {field, after} | flat | null, pivot, expand, treeOpen: Set<recordId> }`.

- **Gestures.** Sort, filter, search, page, group, view, pivot, drill and control-parameter rebinding are `dispatch(gesture)` on that store. A pure reducer applies each one to `requested`, using the `applyRecordsTableQueryChange` rules from `records-table-state.ts`, so a second rapid gesture builds on the first and never on a stale URL. A read starts when `requested` differs from `shown`. The latest read wins by a generation number per store, and `shown` is set from the read that lands. This replaces `shownRef`, `pendingRef` and the local `requestedSort` in `table-grid.tsx`.
- **One address writer.** `table-address.ts` is the only code that touches `history`. It writes the URL with push for query parts and replace for display parts, from store changes, after each reducer step. Control page parameters go through the same writer.
- **Address reads.** The address is read once on load (from `model.tableAddress`) and on `popstate`, which replaces `requested` and so starts a read.
- **Removed.** The `window.location` reads in `use-table-page-address`, `use-group-members`, `use-page-parameters`, `use-grid-layout` and `use-range-summary`, plus the address-diff effect.
- **Display.** The UI renders `requested` sort, search and filters at once through `runtimeInputs`. Inline edit keeps its revision-gated hold in `EditableCell`, which is the #3462 behaviour without the extra copy.

## C3: one grid feature definition contract

The platform half extends `RecordsTableFeatureDefinition`:

`{ key, label, description, settings: <catalogue group declaration with defaultValue>, read, check, project(state, facts, viewer) → projection part, refusals: Record<code, {message, guidance}> }`

- **Registry and catalogue.** The registry is `gridFeatureDefinitions` (an array), and keys, types and the projection schema derive from it. The Table release's `features` group in the catalogue is assembled from `settings` (identical content, so the release hash does not change), so Puck `defaultProps` stay the one source of defaults. Every feature key is always present and off by default, and strict readers stay strict.
- **UI half.** `defineGridFeatureView(definition, { renderer, studioPanel, start })` in `ui` imports the platform definition object, which respects the layering rule. The UI and Studio registries are arrays of views, derived by key from that object.
- **One check.** Studio, both publication passes and runtime projection call `definition.check`. Runtime gating that duplicates the check is removed.
- **Guard.** A new blocking rule, `grid-feature-definition`, with an owner and a review-by date. A feature key literal may appear only in its definition file, every refusal code has a sentence, and every setting has a default. It replaces the key-set comparison in `grid-feature-registry`.
- **Proof features.** Sort and filter (core query), pinning and totals move fully onto the contract. `docs/build-plan/grid-feature-fanout.md` lists the other 14 features with files, steps, acceptance criteria, the issues each closes, and their complexity.

## Risks

- **C1 behaviour drift.** C1 is a 1,700-line security-critical rewrite with no tests. The function bodies are moved, not rewritten. Before and after outputs are compared on db3 for each mode as owner and restricted member, with `pg_get_functiondef` checked.
- **Lookahead order in the generalised scan.** The order of membership lookahead can change which rows a budget-limited page examines. Results stay correct, but the continuation points may differ.
- **Back and forward in C2.** `history-refresh.tsx` (outside my files) calls `router.refresh()` on every `popstate`. C2 must make the store's popstate read the only reread for table-only changes, which needs a one-line change there. I will ask before touching it.
- **C3 catalogue assembly.** If the assembled `features` group differs by even key order, the release content hash changes and shipped definitions must be republished in the same PR.
