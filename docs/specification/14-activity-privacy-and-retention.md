# 14. Activity history, privacy and retention

[Previous: Connections and programmable interfaces](12-connections-and-interfaces.md) · [Specification index](README.md) · Next: [Entitlements and metering](15-entitlements-and-metering.md)

## Data inventory

Every category of organisation or person data has an owner, purpose, location, access policy, default retention period, deletion method, export method, and legal-hold behaviour.

```mermaid
flowchart TD
    DATA[Data created or received] --> CLASSIFY[Classify purpose and sensitivity]
    CLASSIFY --> USE[Use under access policy]
    USE --> RETAIN{Retention still required?}
    RETAIN -- Yes --> STORE[Keep protected and review later]
    RETAIN -- No --> HOLD{Legal hold?}
    HOLD -- Yes --> STORE
    HOLD -- No --> REMOVE[Remove content and dependent copies]
    REMOVE --> RECEIPT[Keep non-content removal receipt]
```

The inventory covers tenants, tenant-administrator assignments, global identities, organisation accounts, definitions, records, relationships, files and previews, search documents, saved views, guided-form drafts, activity, events, workflow inputs and references, connection messages, metering events, exports, backups, caches, logs, and protected support-access evidence. Business-domain records remain discoverable through their module field classifications rather than a privileged list of business applications.

## Activity history

Activity entries explain material business and administrative changes. They include organisation, time, actor, action, subject identifiers, correlation identifier, source surface, outcome, and safe changed-field names.

Activity does not store passwords, connection secrets, full sensitive values, private file addresses, or complete before-and-after record copies. Where a business audit requires a value history, that history has an explicit field policy and access permission.

Activity is append-only through ordinary product operations. Corrections create a later entry. Privileged retention work may remove protected content while preserving a non-content receipt.

## Personal-data classification

Every [field](05-modules-fields-and-relationships.md) is classified as:

- `none`: not intended to identify or describe a person.
- `personal`: identifies or describes a person.
- `sensitive`: higher-risk personal or confidential information requiring explicit access.

The classification controls search, exports, activity detail, masking in diagnostics, and erasure discovery. Public display is a separate explicit choice under [access and permissions](04-access-and-permissions.md#public-access).

## Retention policies

An organisation can choose approved retention periods within legal and platform safety bounds. A policy names the data category, optional version-pinned saved condition, active retention period, recovery period, removal schedule, and applicable legal-constraint keys. Commercial status never weakens privacy or retention correctness.

- Shortening a period shows an impact preview and requires confirmation.
- Retention jobs are resumable, duplicate-safe, bounded, and auditable.
- Removal covers primary data and active derived copies such as search, previews, caches, and pending exports.
- Backups expire through their own protected schedule; ordinary deletion does not rewrite immutable historical backups.
- Restoring a backup must reapply removal records created after that backup before the restored system is opened for ordinary use.

## Protected personal-data operations

The platform supplies protected discovery, export and removal operations because they must consistently cover arbitrary application records, files, search, caches and derived data. A removal command names its tenant, organisations, data categories, optional version-pinned saved condition or protected subject fingerprint, requesting and authorising actors, issue time and correlation identifier. It does not contain a business request lifecycle, findings queue or approval case.

Privacy request intake, identity verification, findings, correspondence, decisions and case progress are ordinary records in a locked Privacy Operations application. That application invokes the protected operations after its own authorised workflow has reached the required outcome.

An **organisation-scoped request** covers one organisation account and the personal data that organisation controls. It must not delete the global identity or affect accounts in other organisations. A **global identity closure** verifies the person, coordinates an organisation-scoped request for every account, closes tenant-administrator assignments, and removes the identity only after required organisation work and lawful exceptions are complete. A tenant-wide request is a tracked batch of organisation-scoped requests, not a shortcut around each organisation's responsibility.

Protected discovery and execution must cover:

- Global identity and organisation accounts.
- Record fields and linked records.
- Files, previews, search entries, and caches.
- Events and workflow payloads.
- Activity values where removal is legally permitted.
- Exports awaiting download.
- Connected systems where the organisation has configured a deletion operation.
- Ownership reassignment for records that must remain.

## Legal holds

A legal hold is an organisation-owned record with a versioned matching scope, reason, authorised creator, start time, review date, and release decision. It prevents permanent removal only for data that matches that scope; it never skips an entire organisation unless the authorised scope explicitly and lawfully matches all of its data. A hold does not make data more visible. Creating, changing, or releasing a hold requires a dedicated permission and recent sign-in confirmation.

## Shared-record accountability

Creating, consenting to, refusing, activating, using, changing, expiring, or revoking a cross-organisation grant is material activity. The source history records the source and recipient clusters, source and recipient organisations, acting global identity, acting organisation account, grant, consented scope, action, outcome, and correlation identifier. One federated query produces one safe request-level activity entry rather than one entry for every returned row. The recipient history records its local request, remote outcome, and correlation identifier without copying source record values.

The source organisation remains responsible for record retention, legal hold, correction, and erasure. A recipient cannot extend retention or prevent source deletion merely because it can read the record. When an erasure, field removal, or legal restriction changes what may be shared, the next list, detail, search, report, dashboard, or export request applies the new result. The recipient holds no search document, materialised report result, or shared-record cache to remove.

A grant never authorises the recipient to include shared personal data in a workflow payload, connection message, recipient search index, or recipient-owned bulk operation. Shared search and reports run at the source and return only fields permitted by the grant. Export is a separate approval that defaults to refused.

Authorised record values may pass through the recipient service and browser for the requested display, search, report, or action, but persistent recipient-cluster business-data storage is forbidden in the first release. The source sharing policy checks the recipient cluster and region before grant activation. Logs, traces, request mirrors, retry records, saved shared-report definitions, and signed receipts contain identifiers and fingerprints only, not shared field values.

An approved export is a deliberate transfer outside live sharing. The source owns the temporary export job and short-lived file, while the recipient cluster retains neither. Once the recipient downloads the file, Vortex cannot recall or remotely erase that copy when the grant is revoked or source data later changes. Both approval screens state this consequence, both histories record the transfer, and the recipient accepts responsibility for permitted storage, onward disclosure, retention, and deletion. A source that requires revocable access leaves export refused.

## Isolation and administration

Privacy administrators act within one organisation. A tenant administrator may coordinate and monitor a batch across the tenant but gains no record access from that role; each organisation's authorised privacy process performs its own search and decision. Support access is time limited, purpose bound, approved, and recorded. Privacy export packages are encrypted, short lived, access checked at every download, and never delivered through an ordinary public file link.

## Acceptance examples

- A sensitive field does not appear in search, ordinary activity detail, or logs by default.
- Erasing one organisation account leaves the same person's other organisation accounts and global sign-in intact.
- Global identity closure coordinates every organisation account and does not claim completion while one organisation request is still pending.
- Shortening retention reports the number and categories of items due for removal before confirmation.
- Restoring an older backup does not resurrect data with a later permanent-removal receipt.
- A legal hold stops deletion without granting the hold administrator read access to the held records.
- An erasure request reports every category searched and any lawful exception rather than claiming success after deleting only the main record.
- Revoking a grant removes future access without erasing the immutable record that approval and authorised use occurred.
- A recipient organisation cannot use a shared record to place a legal hold on the source organisation's data.
- Shared search and reports leave no recipient index or materialised result; the next request reflects source correction, restriction, or erasure.
- A downloaded approved export is recorded as an intentional transfer and is not presented as revocable live access.
