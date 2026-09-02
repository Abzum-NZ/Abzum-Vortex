# 11. Files and attachments

[Previous: Queries, reports, search and live updates](10-queries-reports-search.md) · [Specification index](README.md) · Next: [Connections and programmable interfaces](12-connections-and-interfaces.md)

## File lifecycle

A **file** is organisation-owned stored content with metadata and access rules. An **attachment field** links a [record](06-records-and-lifecycle.md) to one or more files.

```mermaid
stateDiagram-v2
    [*] --> Pending: upload requested
    Pending --> Uploaded: bytes received
    Uploaded --> Scanning: size and type verified
    Scanning --> Active: safety checks pass and record save commits
    Scanning --> Quarantined: safety check fails
    Pending --> Abandoned: upload expires
    Active --> SoftDeleted: record or attachment removed
    SoftDeleted --> Active: restored in recovery period
    SoftDeleted --> Removed: retention period expires
    Quarantined --> Removed: review or retention outcome
```

## Canonical attachment settings

The field contract uses these names only:

- `allowed_kinds`: one or more broad file groups such as image, document, spreadsheet, presentation, audio, video, archive, text, or other.
- `allowed_extensions`: an optional narrower list of filename extensions.
- `max_file_size_mb`: maximum size for one file.
- `multiple`: whether the field accepts more than one file.
- `max_files`: required when `multiple` is true.

Builders choose broad allowed kinds and may add an extension allowlist. When both are present, the detected content kind and extension must satisfy both. A filename or browser-supplied type never overrides detected content, and an unknown or mismatched type is refused or quarantined for review.

Attachment fields are not directly filterable, sortable, or searchable. File name and approved extracted text may be searched through the separate file-search policy if added to [search](10-queries-reports-search.md), but that does not make the attachment field a scalar query value.

## Upload sequence

1. The server checks create/update permission for the target record and field.
2. The server creates a short-lived pending-file record and a restricted [signed upload instruction](https://supabase.com/docs/guides/storage/uploads).
3. The client uploads directly to organisation-scoped [Supabase Storage](https://supabase.com/docs/guides/storage). Large or interruption-prone files use its resumable upload path rather than restarting the complete transfer.
4. The platform verifies actual size, detected content type, extension, checksum, and safety result. Browser-supplied metadata is not trusted.
5. The record save attaches the active file by identifier.
6. Unattached pending uploads expire and are removed.

## Download and preview

- Every download rechecks organisation, record, field, and file access.
- Private storage addresses are short lived and cannot be reused as permanent public links.
- The response uses a safe content type and download disposition where browser display could execute content.
- Preview generation is isolated from the application process and never executes macros, scripts, or active document content.
- Public pages use separately published public-file variants; a private attachment address is never exposed.

## Storage and isolation

- Storage keys begin with the organisation identifier and use unguessable file identifiers.
- Business files live only in private buckets. Public buckets are limited to deliberately published public assets.
- The original file name is metadata, not part of an executable storage path.
- Checksums support duplicate detection and integrity checks but do not grant cross-organisation access or shared storage identity.
- File metadata, previews, extracted text, and deletion jobs carry the same organisation identifier as the original.
- [Storage row policies](https://supabase.com/docs/guides/storage/security/access-control) on `storage.objects` and application checks both enforce organisation separation.
- Downloads use short-lived signed addresses. Image transformation and content delivery acceleration may be used only for approved public assets or a currently authorised short-lived private response; neither changes the file's access rules.

## Attachments on shared records

A record-sharing grant does not automatically grant file access. The grant must name the attachment field as readable, and every list, preview, and download rechecks the source record, grant, field, recipient organisation account, and recipient application. Bytes remain in the source organisation's storage; the recipient receives only a short-lived, request-bound download instruction. Across clusters, the source File service either streams the bytes through the signed [federation request](17-runtime-storage-and-caching.md#cross-cluster-request) or issues a short-lived source-storage grant bound to the same recipient assertion. The recipient cluster does not retain the file or preview.

Uploading an attachment from another organisation requires a separately allowed attachment action. The source File service admits the upload and issues a short-lived source-storage instruction; after safety checks, the source Record service attaches it in the source record save. The new file is owned by the source organisation, follows its limits and retention policy, and records both the acting global identity and recipient organisation account. A recipient cannot browse the source organisation's file store, reuse an upload or download instruction for another account, retain the bytes in recipient-cluster storage, or attach one source organisation's file to its own record.

## Deletion, retention and legal hold

A file follows the lifecycle of the record attachment that owns it unless it has another active owner. Soft deletion preserves the file through the recovery period. Permanent removal follows [privacy and retention](14-activity-privacy-and-retention.md). A legal hold prevents removal but not access restrictions.

## Limits and usage

Uploads enforce per-file, per-field, per-request, and organisation storage limits before accepting bytes where possible. Accepted bytes, retained bytes, preview work, and failed uploads produce generic [metering events](15-entitlements-and-metering.md#metering-events).

## Acceptance examples

- Renaming an executable file to an allowed extension does not bypass detected-type checks.
- A person with record access but without attachment-field read access cannot list or download its files.
- A signed download address from one organisation cannot retrieve a file from another.
- An abandoned upload is removed without creating record activity.
- Restoring a record restores only files still inside their recovery period and not rejected by safety policy.
- Sharing a record without naming its attachment field exposes neither file metadata nor file content.
- A shared-file download remains source-owned, short lived, and checked against the grant on every request.
- A cross-cluster file instruction is unusable after grant revocation and cannot be exchanged between recipient accounts or clusters.
