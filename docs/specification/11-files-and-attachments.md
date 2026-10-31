# 11. Files and attachments

[Previous: Queries, reports, search and live updates](10-queries-reports-search.md) · [Specification index](README.md) · Next: [Connections and interfaces](12-connections-and-interfaces.md)

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
    Uploaded --> Abandoned: upload expires before Save
    Scanning --> Abandoned: upload expires before Save
    Quarantined --> Abandoned: never-activated upload expires
    Abandoned --> Removed: scheduled Storage cleanup succeeds
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
2. The server creates a short-lived pending-file record and the exact-object upload credential defined in [the Storage credential bridge](#storage-credential-bridge).
3. The client uploads directly to organisation-scoped [Supabase Storage](https://supabase.com/docs/guides/storage). Large or interruption-prone files use its resumable upload path rather than restarting the complete transfer.
4. The platform verifies actual size, detected content type, extension, checksum and safety result, then rechecks current authority before activation. A still-valid upload token does not authorise attachment after access revocation. Browser-supplied metadata is not trusted.
5. The record save attaches the active file by identifier.
6. Never-activated uploads expire after 24 hours, including clean inspections awaiting Save and rejected content. Scheduled maintenance marks a bounded batch abandoned under the same file-row lock as record activation, removes their private objects through the Storage API, and then removes upload state. Failed deletions retry after their cleanup claim expires. Active attachments and held files are excluded.

A flow file task calls this same File-service boundary for the flow's Access-resolved effective actor. A system execution authority never bypasses record, field, file, storage, safety, retention or entitlement checks, and no service-role credential acts as a file grant. File references or metadata returned to a different initiating viewer are projected through that viewer's current authority before display or later use.

## Download and preview

- Every download rechecks organisation, record, field, and file access.
- Private downloads/previews use an authenticated File-service route that rechecks current authority on every new request, including range requests. Upstream Storage addresses remain server-side; do not redirect clients to reusable bearer signed URLs.
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
- Public assets may use content acceleration. Private/shared responses use private/no-store handling and the authenticated gateway, without persistent recipient copies. [Supabase signed URLs](https://supabase.com/docs/guides/storage/serving/downloads) remain usable until expiry and cannot by themselves enforce Vortex grant/account revocation on each request.

### Storage credential bridge

The selected bridge is a destination-project JWT signed with an imported asymmetric Supabase signing key, supplied through the client's `accessToken` option (or the equivalent Storage HTTP bearer header). Supabase documents [externally minted JWTs](https://supabase.com/docs/guides/auth/jwts#using-custom-or-third-party-jwts), [imported signing keys](https://supabase.com/docs/guides/auth/signing-keys), and [Storage JWT-backed row policies](https://supabase.com/docs/guides/storage/security/access-control). This is a required design for [#92](https://github.com/Abzum-NZ/Abzum-Vortex/issues/92), not a claim of implemented or hosted-verified behaviour.

The source File service first runs the ordinary Access-resolved operation. It then mints a token valid for at most 60 seconds, with `role=authenticated`, the destination project's issuer, a File-specific token kind, destination project, source organisation, exact bucket/object path, allowed Storage operation, expiry, and correlation identifier. Actor attribution identifies the verified human/account or registered system actor; it does not turn a system actor into a human Supabase user. Only trusted server code supplies these claims. User-editable metadata, request parameters, an Identity Authority JWT from another project, and the PostgreSQL transaction context cannot substitute for this credential.

Storage policies on `storage.objects` inspect the signed claims through `auth.jwt()` and enforce the exact destination, organisation path, bucket, object and operation, including both old and new scope for changes. They deny missing/malformed scope, ordinary Auth tokens and unintended list, copy, move, overwrite or signed-download operations. Use Storage's operation helpers where SQL privileges alone conflate listing and reading. These policies provide independent object/operation isolation; the File service owns the full live record/field/grant decision. No grant or schema access to private Vortex service/context tables is added for `authenticated`.

Read, preview, removal and other server operations keep this credential and all upstream addresses server-side. Each new external request, including ranges, rechecks current Access before minting its own credential. A browser receives only an upload credential for INSERT at its admitted pending-object path, with no read/list/update/delete/upsert authority. Resumable uploads renew through File admission and a fresh Access check; a still-valid credential may finish depositing pending bytes after revocation, but activation always rechecks current authority and refuses them. Replacement uploads use a new pending object and an authorised record save, never unrestricted overwrite.

The signing key stays in the destination environment's server secret store, separate from Identity Authority keys, and rotates with the documented provider overlap/revocation procedure. It is a trusted minting credential, not a sandbox against compromised server code; no `service_role`/secret API key enters ordinary file execution. Local and scoped system operations use this same source-side bridge after their own Access resolution. The #92 implementation must preserve the exact accepted claims, recheck authority on resumable renewal, refuse unintended operations and support key rotation. A simulated policy check or broad key cannot replace these source-level safeguards.

## Deletion, retention and legal hold

A file follows the lifecycle of the record attachment that owns it unless it has another active owner. Soft deletion preserves the file through the recovery period. Permanent removal follows [privacy and retention](14-activity-privacy-and-retention.md). A legal hold prevents removal but not access restrictions.

## Limits and usage

Uploads enforce per-file, per-field, per-request, and organisation storage limits before accepting bytes where possible. Accepted bytes, retained bytes, preview work, and failed uploads produce generic [metering events](15-entitlements-and-metering.md#metering-events).

## Acceptance examples

- Renaming an executable file to an allowed extension does not bypass detected-type checks.
- A person with record access but without attachment-field read access cannot list or download its files.
- A copied private download route fails for another account and after revocation, including preview and range requests. Already delivered or intentionally exported bytes cannot be recalled.
- An abandoned upload is removed without creating record activity.
- Restoring a record restores only files still inside their recovery period and not rejected by safety policy.
- Destination Storage refuses wrong-organisation/object/operation claims, a foreign-project identity token and an ordinary local Auth token without File scope; the valid local, federated and system paths use no broad server key.
- A pending upload credential cannot list, read, overwrite or remove files; renewal and activation refuse revoked authority. A captured private download route cannot obtain a fresh server credential after revocation.
