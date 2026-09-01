# 10. Queries, reports, search and live updates

[Previous: Workflows and process pipelines](09-workflows-and-pipelines.md) · [Specification index](README.md) · Next: [Files and attachments](11-files-and-attachments.md)

## One read path

Lists, dashboards, reports, workflow selections, exports, programmable interfaces, and search all use validated read contracts and [access](04-access-and-permissions.md). None may bypass record visibility or field permissions.

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

## Pagination and limits

- Results use stable continuation tokens rather than unbounded offsets for large datasets.
- A stable unique tie-breaker is appended to every sort.
- Page-size limits depend on the calling surface and are listed in the [data contracts](appendices/data-contracts.md#query-limits).
- Counts and totals use the same access scope and filters as the rows.
- Exports and workflow loops page through the same query contract rather than requesting an unlimited result.

## Saved views

A saved view records the query, visible columns, arrangement, grouping, sort, and display choices. A personal view is visible only to its owner. A shared view belongs to an application and requires a permission to publish or change.

The term **saved view** replaces the outdated terms “prepared list,” “prepared query,” and “prepared view.”

## Arrangements and reports

- A table presents rows and columns.
- A board groups records by a filterable choice field with no more than twelve options.
- A calendar places records by a date or date-time field and uses the duration rule in [Decision D05](appendices/decisions.md#d05-calendar-duration).
- A summary groups and totals compatible fields.
- A dashboard composes several bounded query blocks.

Every chart or report states its measure, grouping, filter, time zone, and treatment of missing values. Money results follow [Decision D08](appendices/decisions.md#d08-multi-currency-totals).

## Shared-record reads

If same-cluster cross-organisation sharing is selected in [D31](appendices/decisions.md#d31-cross-organisation-sharing-release-scope), a shared-record query uses the same validated query contract but names the source organisation and grant context. Every returned row retains its source-organisation identity. A query cannot join, group, or total source-owned records with recipient-owned records as though they had one owner.

The first-release draft exposes shared records through dedicated shared lists and record detail only. It does not place them in the recipient's global search index, ordinary dashboards, workflow selections, assistant context, or bulk operations. The product boundary remains [Decision D34](appendices/decisions.md#d34-shared-record-product-surfaces).

Shared queries bypass the cross-request data-result cache under [runtime and caching](17-runtime-storage-and-caching.md#grant-cache-invalidation). Pagination, counts, and fields are calculated using one independently sufficient active grant; a query cannot combine scope from one grant with fields or actions from another.

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
- A recipient organisation's index never receives another organisation's shared record content in the first release.
- Candidate results are rechecked against current access before display.
- Deleted or newly hidden records are removed or made unavailable within the limit recorded in [Decision D18](appendices/decisions.md#d18-search-and-cache-freshness).
- Search priority `first`, `normal`, and `last` affects ranking without overriding access.

## Live updates

Live updates tell an open page that relevant data may have changed. They carry organisation, application, record type, record identifier, change kind, and sequence—not private field values.

The client re-runs a permitted query or reloads the permitted record. Subscription channels are organisation-scoped and authorised on connection and renewal. A shared-record screen may receive a content-free invalidation tied to an active grant, then re-run its authorised query. A live message never carries source record values or makes an unreadable record visible.

## Acceptance examples

- An unfilterable address field causes a clear query refusal; the condition is not dropped.
- Search cannot return a record that a direct read would refuse.
- Count, chart, export, and list results agree for the same access scope and filter.
- Pagination neither duplicates nor skips records when several records share the visible sort value.
- Removing access prevents live updates and makes subsequent refreshes refuse the record.
- Shared records do not appear in recipient search, ordinary dashboards, workflows, assistant context, or bulk operations unless [D34](appendices/decisions.md#d34-shared-record-product-surfaces) deliberately expands the first release.
