# 10. Queries, reports, search and live updates

[Previous: Workflows and process pipelines](09-workflows-and-pipelines.md) · [Specification index](README.md) · Next: [Files and attachments](11-files-and-attachments.md)

## One read path

Lists, dashboards, reports, workflow selections, exports, programmable interfaces, and search all use validated read contracts and [access](04-access-and-permissions.md). None may bypass record visibility or field permissions. A system module's read-only [system record type](appendices/core-contract-boundary.md#system-modules) is read through this same closed contract: organisation isolation, field permissions and the viewer's current authority apply before any row, count, group or total is produced, and its protected operation remains the only write path. A system record type adds no separate reader, endpoint, materialised copy or cross-request cache, and a query over one always bypasses the cross-request data-result cache ([runtime and caching](17-runtime-storage-and-caching.md#cache-model)).

```mermaid
flowchart LR
    SOURCE[Page, report, workflow, export or interface] --> VALIDATE[Validate fields, filters, sort and limits]
    VALIDATE --> ACCESS[Add organisation and record visibility]
    ACCESS --> DB[(Organisation records)]
    DB --> SHAPE[Remove unreadable fields and format values]
    SHAPE --> RESULT[Bounded result and continuation token]
```

## Query contract

A query names:

- One record type.
- Fields to return.
- A typed filter tree.
- Optional grouping and totals.
- A stable ordered sort.
- A bounded page size and continuation token.
- At most two declared relationship hops.
- The application and published definition version where relevant.

Every selected, filtered, grouped, totalled, or sorted field must permit that operation in its [field definition](05-modules-fields-and-relationships.md). An invalid or unsafe filter refuses the entire query. The platform never removes an invalid condition and runs a broader query.

The published selected-field list is an explicit record projection. On a grouped
Query, it may include card/member fields as well as the grouping key. Grouped
sorts still name grouping keys, and a summary returns only its declared grouping
keys and aggregates; adding selected member fields does not add them to summary
output.

A module-exposed query is this same closed query contract published under a stable module-owned identity and exact release. A flow may invoke only a query exposed by its resolved module dependency; it cannot supply raw SQL, broaden the projection, or infer a query from a label. The query executes for the flow's Access-resolved effective actor. If a different initiating viewer receives its result, the runtime applies the viewer's current readable projection before returning it, and any later write is authorised independently. [Query execution #54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54) owns the actual protected Query execution and receipt boundary; [record actions and events #50](https://github.com/Abzum-NZ/Abzum-Vortex/issues/50) owns record-operation and event declarations. These target flow semantics do not claim either runtime is delivered.

A flow's Query node publishes exactly one `ProtectedOperationReference`, containing the query's owning Application or Module and its permanent query ID. That reference is part of the node's exact release mapping, so a grant cannot be reused for another node or query.

## Query exposure

Every Module query declares `exposure`: `private` (the default a new query gets) or `exposed`.
The Application that owns the Module reads all of its queries. An Application that only uses the
Module reads its exposed queries and nothing else. One rule decides it in every place: the Studio
data picker and its store-time check offer only exposed queries of used Modules, the draft compile
and publication validation refuse a page, block or interface that names a private query of another
Application (`vortex.definition.application_query_exposure`), and the database query preparation
refuses to read it, so neither a hand-written request nor a release compiled before exposure
existed can bypass it. A published Application release pins the exact Module release it was
compiled against: when the owner makes a query private, a release that already reads it keeps
reading that pinned, exposed revision, and the borrower's next publication is refused with the
query named, so nothing breaks silently. A
record type's own listing is not an authored query and follows record access. Studio's Data tab
lists the Application's queries ("This app", with an Expose switch) and the exposed queries of the
Applications it uses ("From other apps", read-only), each with its record type, inputs and uses.

## Exact field values in queries

Read value meaning from the exact published Module contract and its field settings,
as defined in [Record value formats](05-modules-fields-and-relationships.md).
For the current Module contract, decimal values travel as exact decimal text but filter, sort and
aggregate as numbers: `2` precedes `10`, not the reverse. Do not convert them
through a JavaScript floating-point number, including in continuation tokens or
returned totals. Text fields containing the same characters remain text.

Money results retain both exact amount and resolved currency. Amount comparisons
follow the [Rule semantics](https://github.com/Abzum-NZ/Abzum-Vortex/issues/44):
equality includes currency, and ordering amounts across currencies is refused.
The existing mixed-currency total refusal below remains unchanged. Query, Rule
and database-backed conditions must agree for the same typed operands. Formatting
for display never changes filtering, ordering or the stored value.

Module query minimum and maximum also accept declared text and yes/no fields.
Text uses Unicode code-point ordering without normalization or case folding;
yes/no orders `false` before `true`. Each result retains the selected scalar,
including empty text or `false`, in the existing `completed`/`value`/`valueCount`
envelope. Absent, null and withheld field values do not contribute; an empty
minimum or maximum returns `null` with `valueCount` zero. The same semantics
apply to readable in-memory arrangements, protected summaries and board metrics.
Sum and average still require whole numbers, decimal numbers or money for ordinary
fields. Installed Summary and Board placements accept a same-record calculation
only when its expression is numeric, its evaluation is explicitly stored, and
its result type is `whole_number` or `decimal_number`; they use the matching
whole-number or decimal aggregate rules. Board metrics apply those rules to
global, column and unassigned results. When an aggregate source is derived, all
candidates go through `read_record`, so a hidden calculation operand or
related-total dependency contributes no value. Total sources, money calculations,
omitted or read-time calculations, nonnumeric calculations, and complex derived
grouping remain unsupported. The field-less `count` descriptor is unchanged.

These requirements belong to [Query execution #54](https://github.com/Abzum-NZ/Abzum-Vortex/issues/54)
and its real storage path, not to a browser-only correction after rows are paged.

## Pagination and limits

- Results use stable continuation tokens rather than unbounded offsets for large datasets.
- A stable unique tie-breaker is appended to every sort.
- Page-size limits depend on the calling surface and are listed in the [data contracts](appendices/data-contracts.md#query-limits).
- Counts and totals use the same access scope and filters as the rows.
- A database-backed summary examines at most 100,000 candidate rows per request (`summary_candidate_limit`). Above that ceiling it returns the neutral `dataset_limit_exceeded` refusal without groups or totals.
- Exports and workflow loops page through the same query contract rather than requesting an unlimited result.

## Records table grid features

The Records table grid itself (columns, sorting, density, sticky headings, resizing, reordering and showing or hiding columns) is always available. Everything else is an optional **grid feature**, authored in the table's one `features` setting group as `{ enabled, ...its settings }` and off by default: search, column filters, saved views, bulk actions, inline editing and related records (master/detail). Later features (grouping, totals, conditional formatting, export) join the same gate.

One gate decides every feature, in three places that cannot disagree:

1. **Capability check.** Each feature has one check over the bound query's facts: its selected fields with their type and sortable, filterable and searchable flags, choice sizes, relationships and the record type's named actions. It answers "Available" or "Not possible" with one business sentence, for example "Column filters need a field the query can filter by." or "Stage cannot be filtered: it is not selected by the query." Studio runs it on the draft beside each feature's switch; publication runs the same check on the compiled release and refuses with the same sentence.
2. **Server projection.** Every table read projects the features this viewer may use now: authored on, published, and permitted under the viewer's current access and field policy (a filter on a field the viewer may not read, a bulk command no row allows, or an inline edit of a field no row lets the viewer change is not projected). The projection travels in the table payload; it adds no request, and a table with every feature off carries none. Any feature request that is not projected on (a search, a filter, a bulk command or an inline edit, including one sent to the flow route) is refused with the neutral refusal and its cause is logged.
3. **Lazy code.** The browser downloads a feature's code only when the projection turns it on; a table with every feature off loads none of it.

A feature that is off holds only its switch, so it compiles to nothing: its flow bindings are not compiled and its controls never render.

### Related records (master/detail)

A row expands to the records of another record type that link to it, for example a company's opportunities. The feature names the **link** from the related record type to the table's record type, the **related records query** of that record type, the query's **input bindings** and the **related columns** (fields that query selects), and reads **at most 40 related records at a time** (Studio starts at 10). The query's inputs bind through the one parameter-binding contract every data block uses; one input is bound to **This row** (the row's record, or one of its fields), which only a row's related records offer. The capability check refuses with the part that does not fit: "Related records need a link from another record type to Company", "Opportunities of one company does not read Contact", a column the query does not select, a page size above 40, a binding the binding check refuses, or a query with no input bound to This row.

At run time a row expands only when the projection says rows expand. Each expand reads one page of that row's related records on the server, and each "Show more" reads the next page with the continuation token the Query engine sealed for that read; collapsing a row and drawing the page read nothing, and a hidden or collapsed row fetches nothing. The browser sends only the table's placement, the row's record identity and the token: the server projects the page again for the viewer (the table must still be on it and usable), reads the row again under the viewer's current access (a row the viewer cannot read is refused), resolves the query's inputs with This row set to that row, and runs the related records query through the protected Query engine with only the related columns, under the viewer's field policy (a withheld value shows as Restricted). Link titles, including each related record's own page address, are read in one batch. A refused read shows "You do not have access to these records" and logs the cause. At most three rows are expanded at once: opening a fourth collapses the oldest and says so. Related rows do not count towards the table's page budget.

### Column filter semantics

A column filter is typed by the field's **canonical type**, never by its display format, and each filterable field holds at most one filter:

| Field type | Filter |
| --- | --- |
| Text, long text, email, phone, web address, reference number | Contains the text (at most 200 characters). |
| Choice, several choices | Any of the chosen options (OR within the field); choosing none clears the filter. |
| Whole number, decimal number | An inclusive range of exact decimals; either end may be open. Values are exact decimal text, never floating point. |
| Money | An inclusive amount range in one named currency (the field's fixed currency when it has one); a value in another currency is outside every range. |
| Date | An inclusive range of calendar days; either end may be open. |
| Date and time | Whole days in the organisation's time zone: from the first instant of the start day (inclusive) to the first instant after the end day (exclusive). |
| Link | Any of the chosen records, picked through the protected bounded record picker under the viewer's access; their titles are read in the page's one batched link read. |
| Yes/no | Equals yes or no. |

Calculated fields, totals and other types take no filter. The filters of different fields AND together and AND the published query filter, so a filter only ever narrows the query. The page address carries each filter as `filter.<placement>.<field>=<kind>:<operand>` (one codec for the runtime, the address, saved layouts and Studio preview); a malformed, inverted, open-on-both-ends or repeated filter refuses the read rather than being dropped. The server rebuilds every condition from the installed field (type, options, currency and link target) and refuses a filter on a field the feature does not declare, a field whose filter kind does not match its type, or a feature that is not projected on. A field the viewer's current field policy withholds is not offered, and a forged filter on it is refused by the Query engine. A committed filter is one bounded read of that table only, from page one with the selection cleared; text commits after a 300 ms pause, and a reply for an earlier state is discarded. Every supported filter, money ranges included, is pushed into the indexed candidate scan when its field is readable for the whole record type.

### Column menu and toolbar

Each column heading has one menu, opened by its chevron, Enter or Alt+Down (Escape closes it and returns to the heading). Its core items are always offered where the column supports them: Sort ascending, Sort descending, Add to sort and Clear sort (Shift+click or Shift+Enter on the heading also adds a sort key), Move left, Move right and Hide column. A column whose **Auto-size** setting is on (off by default) also offers Auto-size column, which fits the column to its heading and the cells of the page on screen, within the column width bounds, and stores the width in the person's layout; its code loads only when such a menu opens. Grid features add their own items to the same menu through the feature registry, only when the viewer's projection turns them on.

The table has one toolbar in a fixed order: the projected features' items (search, filter chips, the view switcher), row density, Columns, then export and Full screen. There is no authored toolbar list: an item shows only when its feature is projected on, while density, Columns and Full screen are the table's own. On a phone the table's own controls fold into one More menu. **Allow full screen** (on by default) offers a Full screen button (Ctrl+Shift+F): the table fills the window as an in-app layer, and the browser's full screen is requested too where allowed; Escape or the shortcut leaves it and focus returns to the button. Entering or leaving keeps scroll, selection and an open editor, and reads nothing. Layout actions (density, hide, move, auto-size, full screen) read no records; a sort reads one bounded page, and the server re-checks that every sort key is sortable.

## Saved views

A saved view records the query, visible columns, arrangement, grouping, sort, and display choices. A personal view is visible only to its owner. A shared view belongs to an application and requires a permission to publish or change.

The term **saved view** replaces the outdated terms “prepared list,” “prepared query,” and “prepared view.”

## Arrangements and reports

- A table presents rows and columns.
- A board groups records by a filterable choice field with no more than twelve options.
- A calendar uses the page's explicit start/end or start-plus-duration mapping from [modules and fields](05-modules-fields-and-relationships.md#field-types).
- A summary groups and totals compatible fields.
- A dashboard composes several bounded query blocks.

A protected board-member page uses the same installed grouped Query, typed
inputs, published filter, optional narrowing filter, and current viewer
authority. It requires one filterable choice grouping key and its installed
options, and returns only requested fields from the Query's published selected
projection. The scan orders by protected record identity, never by the choice
value. Membership uses the choice value only when that value is present in the
current readable projection; missing, withheld, null, and undeclared values
belong to unassigned. Its encrypted continuation binds the installed Query
revision, actor and installation, typed inputs, selector, filters, projection,
page size, and record-identity order. Each page rechecks the live installation
and record permissions, and member pages are not cached across requests. This
operation supplies bounded column members.

A protected board summary uses the same installed grouped Query, exact release,
typed inputs, authority and filters. It requires the sole grouped choice field
to appear in the published selected projection and uses its current installed
options in order. It counts every permitted filter-matching row, including
rows whose choice is missing, withheld, null or not an installed option; those
rows share one unassigned bucket. It returns each option and unassigned bucket
even when empty, with the Query's declared aggregates for that bucket and the
same aggregates across all eligible rows. Withheld aggregate values do not
contribute, while their readable rows still count. The operation is uncached,
refuses neutrally above the 100,000-candidate ceiling, and returns no records,
raw groups or option permission identifiers. It does not promise an atomic
snapshot across separate member and summary requests, and it does not compose
board blocks.

A protected grouped-member page reads one exact group of an installed grouped
Query in record-identity order. Its selector supplies every installed grouping
field once, using the same typed JSON values and representations as the generic
summary. Membership is checked only after the current record read and published
and narrowing filters pass: every grouping value must be present in the current
readable projection and equal the selector value, with JSON null matching only
JSON null. A missing or withheld grouping value belongs to no generic group, and
the grouping fields need not be selected for row output or declared filterable.
The page returns the installed group identity even when it has no rows. Its
opaque `protected-group-members-v1` continuation binds the actor, installation,
release revision, selector, inputs, filters, projection, page size and
record-identity order. Each page rechecks the installation and live record
authority; grouped-member pages are uncached and scan at most 500 candidates
while returning at most 200 rows. This operation returns no group counts or
aggregates and does not compose or place grouped tables.

Every chart or report states its measure, grouping, filter, time zone, and treatment of missing values. A money total is refused unless the filtered group contains at most one currency; no implicit conversion or split result is produced.

## Shared-record reads

A shared-record query uses the same validated query contract whether the source is local or in another cluster. It names the source cluster, source organisation, grant, recipient application, and requested surface. Every returned row retains its source identities and displays a plain source-organisation marker. A query cannot join, group, or total source-owned records with recipient-owned records as though they had one owner, and one query cannot join records from several source clusters.

For a cross-cluster read, the complete filter, sort, field projection, page size, and continuation token are sent once to the source through the [federation query contract](appendices/data-contracts.md#federated-query-and-action). The source validates and executes the query, applies the grant and database row restrictions, and returns only the approved fields. The recipient never fetches a broad remote set and filters it locally, and it never makes one remote call per returned record.

The recipient uses the ordinary list, record-detail, search-result, report, and export components for shared records, so supported work behaves consistently with recipient-owned records. The component obtains an operation-capability description with the result and shows only the fields and actions permitted by the complete grant. Source ownership, temporary unavailability, and any measured remote delay remain visible rather than being disguised as local ownership.

```mermaid
flowchart LR
    UI[Ordinary record component] --> GW[Shared-record gateway]
    GW --> SOURCE[Source Query service]
    SOURCE --> CHECK[Grant, application, role, condition and field checks]
    CHECK --> MODE{Approved request}
    MODE --> VIEW[List or record detail]
    MODE --> SEARCH[Search result]
    MODE --> REPORT[Report or dashboard block]
    MODE --> EXPORT[Source-generated export]
    VIEW --> EPHEMERAL[Request-only result with source marker]
    SEARCH --> EPHEMERAL
    REPORT --> EPHEMERAL
    EXPORT --> FILE[Short-lived approved download]
```

Application search may include a **Shared** result group. The search coordinator asks only the bounded set of active grants known from non-content grant mirrors, runs each search at its source, and merges only the returned approved projections for the current response. Shared content is never written into the recipient search index. An unavailable source produces an unavailable source group; it does not make the whole local search fail or return stale results.

A saved report or dashboard block may use one source organisation, record type, and grant. Its definition may be stored by the recipient because it contains identifiers, fields, filters, grouping, and presentation settings rather than source record values. Rows, counts, groups, and totals are calculated by the source on each run and are not materialised in recipient storage. A report cannot mix source-owned and recipient-owned values or combine several source organisations into one total.

Approved export uses the same source-executed query and field projection. It is described in [record export](16-copying-sharing-import-export.md#record-export). Workflows, connection messages, bulk changes, cross-source relationships, and offline use of live shared records remain outside the first release.

Shared queries bypass the cross-request business-data cache under [runtime and caching](17-runtime-storage-and-caching.md#grant-cache-invalidation). Pagination, counts, and fields are calculated in the source cluster using one independently sufficient active grant; a query cannot combine scope from one grant with fields or actions from another. A source or network outage fails closed and shows that the source organisation is temporarily unavailable; the recipient does not display an older persisted result.

## Search

Search keeps a separate organisation-scoped index built only from fields marked searchable.

```mermaid
sequenceDiagram
    participant Save as Record save
    participant Queue as Search update queue
    participant Index as Organisation search index
    participant Person
    Save->>Queue: Record identifier and changed searchable fields
    Queue->>Index: Replace permitted search document
    Person->>Index: Search within current organisation and application
    Index-->>Person: Candidate record identifiers
    Person->>Save: Recheck current access and load readable fields
```

- Sensitive fields are never copied into the search index.
- Personal fields are indexed only if explicitly marked searchable and permitted by the organisation privacy policy.
- Results are scoped by organisation, application discoverability, record visibility, and field access.
- A recipient organisation's index never receives another organisation's shared record content. Shared search is executed by the source and merged only into the current response.
- Candidate results are rechecked against current access before display.
- Access removal affects the next search request because results are access-checked at read time. Ordinary record creates and changes appear in search within 10 seconds under normal operation. A delayed index shows a freshness warning and triggers recovery; it never bypasses the current access check.
- Search priority `first`, `normal`, and `last` affects ranking without overriding access.

The local literal-search matcher accepts an optional `expressionMode` with only `literal` and `or` values; omitting it keeps the existing literal AND grammar, and any other value is refused. In `or` mode, an expression is one or more nonempty AND groups separated by an exact uppercase, unquoted, whitespace-delimited `OR` token. Lowercase `or`, quoted `"OR"`, and other punctuation remain literal terms. AND binds within each group, and a candidate matches when every term in at least one group occurs in the current readable requested fields. A quoted phrase must match as consecutive normalized tokens within one field. A malformed quote or empty group refuses the complete expression before candidate text is read. Positive term indices remain global and left to right; separators have no index, and matched fields report actual matches even for an incomplete group. The existing 2,000-character expression, 32-term, 64-phrase-token, and 1,000-candidate bounds and result shape remain unchanged. This local grammar does not define application serving, ranking changes, or the remaining search features.

## Live updates

Live updates use [private Supabase Realtime Broadcast channels](https://supabase.com/docs/guides/realtime/authorization) to tell an open page that relevant data may have changed. They carry organisation, application, record type, record identifier, change kind, data version, and sequence—not private field values. Channel access is protected by row rules on `realtime.messages` and is recalculated when the connection or identity token changes.

The client treats every message as an invalidation only: it re-runs a permitted query or reloads the permitted record through the ordinary server path. Subscription channels are organisation-scoped and narrowly split by application and surface so a connection does not subscribe to an organisation-wide firehose. A shared-record screen may receive a content-free invalidation tied to an active grant, then re-run its authorised source query. A live message never carries source record values, acts as evidence of access, or makes an unreadable record visible.

Business-record changes use Broadcast rather than exposing direct table-change subscriptions to browsers. This keeps payloads deliberate and permits the same content-free message for derived changes, source-owned shared records, and access-version changes. Complicated business access remains in the normal server and database read path rather than in the channel policy.

```mermaid
sequenceDiagram
    participant Save as Authorised record save
    participant RT as Private Realtime channel
    participant UI as Open component
    participant Query as Authorised query path
    Save->>RT: Content-free invalidation
    RT-->>UI: Record type, identifier and versions
    UI->>Query: Re-run current query
    Query-->>UI: Currently readable result or refusal
```

## Acceptance examples

- An unfilterable address field causes a clear query refusal; the condition is not dropped.
- Search cannot return a record that a direct read would refuse.
- Count, chart, export, and list results agree for the same access scope and filter.
- Pagination neither duplicates nor skips records when several records share the visible sort value.
- Removing access prevents live updates and makes subsequent refreshes refuse the record.
- A captured live message contains no field value and cannot be used to fetch data after access is removed.
- Shared records can use ordinary list, detail, search-result, report, dashboard-block, and approved-export components while retaining a visible source marker and source-authoritative checks.
- Shared search, report, and dashboard results leave no recipient search document, materialised report result, or cross-request business-data cache entry.
- Shared records do not enter workflow selections, connection messages, bulk changes, cross-source relationships, or offline storage in the first release.
- Same-cluster and cross-cluster shared lists return the same fields and refusal meanings for the same grant; only measured latency and source-availability states may differ.

## Page context and derived-value safety

Use [explicit typed binding contexts](appendices/page-builder-contracts.md#data-context-and-related-records) for the page subject, related panels and row items. A valid employee-to-department example does not require every query on the page to target Employees. This is ordinary related-record querying, not permission to join different shared sources.

Evaluate access before grouping, aggregation, counts and pagination. A cached or stored derived result must not expose inputs the reader cannot access. Caller-filtered totals are computed for that caller, not stored as one universal business value. Invalid predicates refuse the affected query rather than being silently dropped.

### Explicit block input bindings

Every query-bound page block maps query inputs through `query_parameters`. Each item names an input and one source: a typed fixed value, a declared page parameter, a readable field of the page subject, the current person, a page control, a relative date, or an authorised parent row inside related records. The same mapping checker supplies Studio and publication messages. No URL name is implicitly a query input.

The server resolves each binding per request. Record fields reuse the authorised subject read; a withheld field is logged without its value and yields `awaiting_input`. Missing required values render the authored awaiting message and make no query. Missing optional values omit their comparison from the query condition, including within conjunctions, alternatives and negation. Additional grid filters only narrow the resulting query. Relative dates use the organisation time zone; date-time inputs receive the start-of-day instant.

Current person supplies a record reference to the signed-in viewer's directory person. Studio offers it only for record inputs accepting that directory type, and publication uses the same type check. The server derives both the installed person type and its record identity from the verified human context, never from a page address or control. A viewer without a directory person is refused, including for optional inputs, so a missing person cannot broaden a "My records" query. Organisation-account-valued inputs are not supported by page bindings.

### Grid grouping execution

Grid grouping is state of the Data grid, executed by `run_module_query_summary` and the protected
`groupedMembers` reader. Query-authored grouping and totals supply defaults; they are not a second
grid engine. The separate `grouped_data` block converges to a Data grid preset in #3085.

The protected readers accept `groupingFieldId` to replace those defaults with one query-selected,
filterable choice field with at most 50 options. A lifecycle stage uses its canonical choice field
identity, never its label. Both readers refuse this override unless the field is guaranteed readable
under the current read plan. The summary retains the 100,000-candidate ceiling and returns a neutral
`dataset_limit_exceeded` refusal above it. Counts describe the currently read result, independently
of a later member page.

Summary and member requests carry the same resolved query inputs, narrowing filter and search.
Search matches only the current readable scalar or choice-array values of fields the record type
marks searchable. A component's searchable-field set may narrow that set; an empty set searches all
searchable fields. Summary search uses per-record access decisions, retaining the candidate ceiling
before it reads records. It does not derive counts from a loaded member page.

Generic member pages take the ordinary ordered sort contract and forward/backward keysets. They
carry at most 200 records, with only the requested field projection. Choice grouping narrows the
candidate scan by its stored key only after guaranteed readability is established, then rechecks
membership from the current readable record. JSON null denotes the unassigned group; a missing or
withheld value never establishes generic group membership. Continuations bind the actor, scope,
release, query, resolved inputs, exact selector, grouping field, sort, filters, search, projection,
page size and direction. Member reads remain uncached.

These reader capabilities are the execution foundation of #3027. The grid feature gate, Studio
controls, single URL codec, group headers and active-group interactions are supplied by that
feature's UI/runtime integration, rather than inferred by the query readers.
