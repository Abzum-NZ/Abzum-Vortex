# 16. Copying, import and export

[Previous: Entitlements and metering](15-entitlements-and-metering.md) · [Specification index](README.md) · Next: [Runtime services, storage and caching](17-runtime-storage-and-caching.md)

## Five distinct operations

The platform separates definition copying, gallery distribution, record import/export, and complete organisation backup transfer. They have different safety and completeness requirements.

```mermaid
flowchart TD
    DEF[Published definition package] --> COPY[Copy into another organisation as draft]
    DEF --> GALLERY[Reviewed gallery listing]
    SHEET[Spreadsheet or structured record file] --> IMPORT[Record import]
    IMPORT --> RECORDS[Organisation records]
    RECORDS --> EXPORT[Record export]
    ORG[Complete organisation state] --> ARCHIVE[Encrypted organisation archive]
    ARCHIVE --> RESTORE[Controlled organisation restore]
```

## Definition packages

A package contains published [modules or applications](03-composition-and-publication.md#definition-ownership-and-versions), a manifest, dependency ranges, stable identifiers, source version, publisher, content fingerprint, required capabilities, and installation notes.

Flows are copied or installed only as part of the immutable release of the module or application that owns them; every flow has exactly one owner. Neither operation copies installation state or run history, and a missing or incompatible flow dependency leaves the candidate unready rather than substituting another version.

A package never contains organisation records, organisation accounts, secrets, access tokens, private files, commercial-system identifiers, activity history, or live connection instances.

## Copying between organisations

Copying creates drafts with new organisation ownership. Before creation, the platform shows:

- Included roots and components.
- Existing dependencies that can be reused.
- Missing modules, themes, connection types, interfaces, roles, blocks, or capabilities.
- Identifier collisions and proposed remapping.
- Connection instances, secrets, public addresses, organisation-specific recipients, and file references that will be cleared.

The copy is always an incomplete draft and never publishes automatically. Every missing dependency must be installed, mapped to a compatible local dependency, or explicitly removed with its affected components. Validation and publication remain blocked until the dependency report is empty.

## Gallery

A gallery listing references a reviewed package version and displays publisher, purpose, required capabilities, requested permissions, dependencies, release notes, and support status. Installation uses the same preview and validation as direct copying.

Removing a gallery listing does not remove installed definitions. A security withdrawal can prevent new installs and warn affected organisation owners without silently changing their live applications.

## Installing and updating an application package

Copying and installation are distinct. Copying produces an incomplete editable draft. Installing selects one exact immutable package and dependency set for one organisation, records one installation identity, and prepares every required runtime integration before that installation becomes ready. Publication alone never installs, updates, or deploys the package.

Installation and upgrade prepare the complete release set and activate it through one transaction (Decision 8). A failed prepare leaves the previous installation active; a failed activation retains the prepared structures for retry. Uninstall blocks new acceptance through Vortex immediately and preserves stored records, installed history and execution history.

## Record import

Record import accepts a documented tabular or structured record format. It includes:

1. Upload and safety checks through [files and attachments](11-files-and-attachments.md).
2. Record-type and field mapping.
3. Type, choice, relationship, required, uniqueness, and access validation.
4. A dry-run report with row-level errors and expected creates/changes.
5. A confirmed bounded background run.
6. A result file and activity summary.

The caller chooses a declared duplicate policy: create only, update by permanent identifier, or update by an approved unique field. The platform never guesses a match from a display name.

### Structured File source

The bounded File source prerequisite reads only an already active, clean, private attachment that is still attached to a readable record field for the current human viewer. It resolves the application's root from the protected File lookup, then rechecks the File read decision and canonical metadata in a fresh application-scoped protected request. A browser-supplied application root, file metadata, decoded rows, or authority object is not accepted as proof. This producer does not create records, choose field mappings, calculate row facts, or authorize an import run; the import preview and execution stages must resolve current published Record definitions and their own per-row facts.

The adopted source format is UTF-8 JSON with the exact format identifier `vortex.record-import/1`. Its top-level object contains only `format`, `columns`, and `rows`. Each ordered column contains a unique, non-empty `columnId` of at most 256 UTF-16 code units (JavaScript `string.length`), matching the current Record planner's mapping and duplicate-policy bounds, and may contain a display-only `label` of at most 256 Unicode code points. Labels can repeat and never provide field identity. Rows are ordered arrays with exactly one cell for each column. The source derives one-based row numbers and maps each row into cells keyed by the stable column identifiers.

Cells preserve JSON null, booleans, strings, arrays, and objects. Numeric tokens must be exact safe integers; decimals and exponents are refused, so exact decimal values must be represented as strings. Duplicate object names are refused after JSON escape decoding. Malformed UTF-8 or JSON, trailing content, extra object properties, and inconsistent row widths refuse the entire source. The decoder performs no coercion or inference and does not evaluate scripts, macros, formulas, dates, or locale-specific values.

The decoder enforces a 5 MiB source limit, at most 500 columns and 500 rows, at most 64 KiB of UTF-8 JSON source representation per cell, nesting depth at most 16, and at most 100,000 JSON values and object-member entries. Lexical and size limits are checked before nested values are materialized. A refusal contains only a closed reason code and, where known, bounded one-based row and column positions; it never includes submitted values, parser diagnostics, Storage details, or private File metadata.

The source verifies the complete streamed byte count and SHA-256 against the canonical File metadata, and rechecks current access, attachment ownership, lifecycle, scanner status, checksum, size, and decision expiry before returning rows. The internal source descriptor carries only the organization, actual source application, file identifier, checksum and size, exact owner record/field identity, current verified viewer identity/account, one server-issued correlation identifier, the decision timestamps, and format version. It contains no Storage path, bucket address, uploader authority, credential, signer, or secret. Missing, foreign, detached, unreadable, inactive, or non-clean attachments receive a neutral refusal with no rows or descriptor.

## Record export

Export uses one [query](10-queries-reports-search.md), current [access](04-access-and-permissions.md), selected fields, declared format and row limit. CSV and Excel are formats of the same bounded download stream, with no retained server file. Sensitive-field export requires explicit permission and is recorded.

<a id="grid-export-csv"></a>

### Grid export (CSV and Excel)

A Data grid offers **Export** only when its table turns the feature on (`features.export { enabled, formats: ["csv", "xlsx"], max_rows }`, off by default) and the viewer holds the record type's standard export permission over every record. Publication and Studio run the same check: “Available”, “Not possible - Export needs the export action on {Record type}”, or “Not possible - Excel export needs a row limit of at most 100,000” when Excel is offered (the authored default is 10,000). The grid projects the control per viewer on every read; the route decides the feature, the permission, the placement and the release again on every request, so a disabled feature or a removed permission is refused even for a hand-made request.

The viewer chooses one of three scopes: the rows ticked on the page (**Export selected**), the records of the current view (**Export this view**), or every matching record with any unticked rows left out (**Export all N matching**). The browser names the scope, the page and the sealed selection descriptor of the read; it never names a field, a query, a permission or a count. The server opens the descriptor for this person, organisation, application, placement and installed release (a forged, foreign, expired or older-release descriptor is refused with its own logged cause), re-resolves the table's bound query and parameter bindings, counts the selection once with the capped count the grid already uses (a selection above `max_rows` is refused, never cut short: “Too many records to export. Narrow the view to at most {limit} records.”), and then streams the requested authored format through the export transport. A known format the installed table does not offer is refused as `format_not_authored`, with its cause logged.

The file has the columns the viewer sees, in the order they see them: the person's own stored layout, else the saved view the grid showed (a candidate that is re-evaluated under their access), else the default view or the authored arrangement. Only fields the viewer may read **and** export are written; a column they cannot export has no heading and no value, and a value withheld on one row is blank. Formatted text, tables and attachments are not exported. Links are written as the permitted title of the linked record, read in one batch per page. Rows are listed flat in the table's order, once each; groups and totals are not exported. Every page of at most 200 records is read under the viewer's current access and export permission before it is written: a permission or field policy removed mid-stream, a release change, or a stale cursor ends the stream, which the viewer is told is incomplete, and the browser never saves a file that did not finish.

Every attempt and outcome is recorded as one content-free Activity entry of the organisation (`records_export_started`, `_refused`, `_finished`, `_cancelled` or `_incomplete`), naming the actor, the record type and the exported columns, never a value, a record or a file. Exact record counts (expected, exported and withheld) go to the server log. Nothing is retained: there is no stored file, signed link or job. CSV and Excel use this same authority, endpoint, audit and transport.

### Grid spreadsheet encoding

The server-only encoder and transport support CSV and Excel. The installed grid authority, route, Studio format choices and lazy runtime download menu are shared by both formats. The runtime offers only the authored formats, including tables that offer Excel alone. Both formats consume the same unchanged sealed selection (selected rows, current view or all matching), protected paging, permission and field-policy rechecks, cancellation and authored cap. Hidden and withheld columns are omitted by the authority before encoding; a per-row withheld value is blank. Links and choices arrive as permitted titles and labels, never identifiers or unresolved objects.

Excel contains one sheet, with a frozen header in visible grid order and widths derived from the grid's pixel widths. It stores text as text, whole numbers and decimals as numbers, money as numbers with the currency code in the number format, and yes/no values as booleans. Numbers keep their declared scale (0–12 places); totals inherit the source field's precision unless an average declares its own. Ordinary money fields have no scale setting, so their cells explicitly retain the stored amount's scale. Calculated numbers without declared precision likewise retain their value's scale. Dates are Excel dates; date-times contain the wall clock in the sealed descriptor's resolved time zone. If the descriptor has no zone, the server reads the organisation's calendar settings under the same access version as its export decision; unavailable settings refuse the export with a logged cause. Excel cells cannot retain a time-zone identifier. CSV preserves the stored decimal/date/time spelling; money is the currency code followed by the amount (`NZD -12.50`), so a negative amount never starts the cell.

Excel supports 15 significant decimal digits. Values that cannot keep their decimal precision as Excel numbers are refused with a logged cause advising CSV to keep every digit. Dates outside 1900–9999, sub-millisecond date-times, text exceeding Excel's 32,767-character limit, and characters that its XML encoder cannot preserve are refused rather than rounded, dropped or truncated. Text and headings in both formats use the same formula neutralisation: prefix an apostrophe when the first character is `=`, `+`, `-`, `@`, tab, CR, LF or a full-width formula marker. Typed negative numbers remain numbers.

Both formats use the one explicit cap of 1–100,000 data rows and pages of at most 200 rows. Excel's 1,048,576-row sheet limit exceeds this ceiling, including the header. The shared Studio/publication check says “Available” or “Not possible - Excel export needs a row limit of at most 100,000”. Crossing the authored cap uses the same refusal in both formats: “Too many records to export. Narrow the view to at most {limit} records.” Rows are committed as they are written, shared-string caching is disabled, and the encoder waits for stream backpressure before accepting another row. A later failure aborts the stream without finalising a partial workbook or reporting completion.

## Complete organisation archive and restore

A complete organisation archive is not a spreadsheet import. It contains versioned definitions, records, relationships, file manifests and encrypted bytes, roles and assignments, retained workflow state, required activity, retention receipts, and a signed manifest. Secrets are excluded or separately re-authorised.

Restore is an operator-controlled disaster-recovery or migration process. It validates supported archive content and integrity, maps identifiers, replays privacy removals, and restores organisation-scoped ownership and access rules before making the restored organisation available. Restored operations use the ordinary protected boundaries described in [functional quality](20-quality-and-acceptance.md#functional-quality).

Under the one flow contract, definition copy, publication storage, consumer read and restore preserve the exact published flow definition, including its ordered tasks, resolved dependencies and immutable publication identity. Maintaining obsolete graph readers or conversion paths is not required.

## Acceptance examples

- Copying an application never copies a usable connection secret or private file address.
- An unresolved required dependency prevents publication of the copied draft.
- Import dry-run and confirmed execution use the same mapping and validation rules.
- Record export cannot include a field the caller cannot read.
- A complete archive restores organisation definitions, roles, files and history; spreadsheet record import restores only the supported record values.
