# Data grid core (#3015)

The Records table grid has one SQL function per query mode, one state owner per page and one feature
definition contract. [grid-feature-fanout.md](grid-feature-fanout.md) lists the per-feature work.

## SQL: one function per query mode

Each public function is `security definer`, owned by `vortex_record_adapter`, granted to
`vortex_request` only, and has its own file in `supabase/schemas/vortex_record/`. Every row-mode
function starts with the same parameters, `(module_root_id uuid, query_id uuid,
expected_release_revision bigint, input_values jsonb, requested_field_ids uuid[],
requested_system_field_keys text[], filter jsonb, filterable_field_ids uuid[]`, then adds its own:

| Function | Mode parameters | Returns |
|---|---|---|
| `run_module_query_rows` | `sort jsonb, search text, sortable_field_ids uuid[], searchable_field_ids uuid[], page_size int, after jsonb, direction text` | `rows, next, opposite, fieldBounds` |
| `run_module_query_exact_rows` | `sort, search, sortable, searchable, record_ids uuid[]` (1..200; page size is the count) | the same |
| `run_module_query_board_column` | `choice_field_id uuid, board_column jsonb` (closed `{kind,value}`), `page_size, after` | the same |
| `run_module_query_board_columns` | `choice_field_id uuid, board_columns jsonb` (1..13), `page_size` | `columns[]`, `fieldBounds` |
| `run_module_query_group_members` | `sort, search, sortable, searchable, grouping jsonb` (or null), `group_values jsonb, page_size, after, direction` | rows plus `groupByFieldIds`, `groupValues` |
| `run_module_query_tree_level` | `sort, search, sortable, searchable, parent_field_id uuid, parent_record_id uuid` (null means roots), `page_size, after, direction` | rows plus `hasChildren` |

Shared owner-only helpers (`security invoker`, owner `vortex_record_adapter`, no grants) hold the
protected path exactly once:

1. `module_query_open_internal(request jsonb)`: request bounds, requested and system fields,
   declared lists, the user sort shape, and `prepare_module_query_internal` (resolution and
   storage). Isolation, permissions and field policy come only from here.
2. `module_query_scan_plan_internal(context, sort, sort_is_user, mode_predicate, after, direction)`:
   sort validation, the composite index, filter pushdown, cursor validation, keyset segments and
   the search prefilter.
3. `module_query_scan_internal(plan, member jsonb, buckets int)`: the one candidate scan (500
   candidate budget, batched page decisions, the exact per-row `read_record` projection and the
   post-read membership test). `member` is a closed internal value the mode functions build:
   `all`, `choice`, `group`, `tree_children` or `tree_roots`.

Summaries have their own functions, each over `module_summary_open_internal`,
`module_summary_plan_internal` and `module_summary_execute_internal`:
`run_module_query_published_summary` (the query's authored grouping and aggregates),
`run_module_query_group_summary` (one grid dimension), `run_module_query_totals` (visible column
totals), `run_module_query_pivot` (two dimensions, one measure) and
`run_module_query_board_summary` (requested board buckets).

Each SQL function has one TypeScript caller in `packages/platform/src/queries/protected-query-*.ts`.

## Client: one state owner per page

`…/application-page-view/page-address.ts` holds the page address in memory: the one owner of every
table's query state (sort, filters, search, page position, saved view, grouping, open group,
pivot) and of the page parameters controls publish. A gesture changes it at once, so a second
gesture builds on the first and never on an older address. Its `write` is the only code that
changes the browser history for table state (push for query parts, replace for display parts); the
location is read only when a page loads and on Back or Forward. The table hooks
(`use-table-page-address.ts`, `use-group-members.ts`, `use-page-parameters.ts`,
`use-grid-layout.ts`, `use-range-summary.ts`) read and write through it. The UI renders the
requested sort, search and filters at once (`requestedSort`); inline edit keeps its
revision-gated hold in `EditableCell`.

## Features: one definition contract

A feature is declared once in
`packages/platform/src/definition/application-composition/records-table-features/<feature>.ts`
(`RecordsTableFeatureDefinition`: key, label, description, settings with defaults, refusals with
sentences, check, events, projection). `recordsTableFeatureDefinitions` is the registry; keys,
types, the projection schema, the Table release's `features` setting group (and so Puck
`defaultProps`) and the refusal sentences derive from it. Studio, both publication passes and the
runtime projection call the same `check`. The UI view registry (`gridFeatureViews`,
`packages/ui/src/display/grid-features/registry.tsx`) and the Studio registry
(`studioGridFeatures`, `packages/ui/src/studio/grid-features/index.ts`) are keyed by the definition
objects. The blocking guard rule `grid-feature-definition` keeps feature key literals in their
definition files.
