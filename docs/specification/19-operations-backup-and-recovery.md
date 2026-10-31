# 19. Operations, backup and recovery

[Previous: Development delivery and environment boundaries](18-delivery-and-testing.md) · [Specification index](README.md) · Next: [Quality, accessibility and acceptance](20-quality-and-acceptance.md)

## Operating goals

Operations keep the platform observable, recoverable, secure, and understandable without giving operators routine access to customer content.

```mermaid
flowchart TD
    SIGNAL[Logs, measures, traces and checks] --> DETECT[Detect problem]
    DETECT --> TRIAGE[Classify scope and customer effect]
    TRIAGE --> CONTAIN[Contain and preserve evidence]
    CONTAIN --> RECOVER[Recover service or data]
    RECOVER --> VERIFY[Run safety and separation checks]
    VERIFY --> COMMUNICATE[Record and communicate outcome]
    COMMUNICATE --> IMPROVE[Correct cause and update runbook]
```

## Observability

Every request and background operation carries a correlation identifier. Logs and measures identify environment, service, operation, safe outcome, duration, and organisation by a protected internal identifier where necessary. They do not contain secrets, private file addresses, complete request bodies, or sensitive field values by default.

Required measures include:

- Request rate, latency, error and refusal rate.
- Database connection, transaction, query, lock, and row-restriction failures.
- Event age, sequence blockage, retry and failed-event count.
- Flow start, segment failure, retry and back-end run reconciliation difference.
- File scan, quarantine, storage and removal backlog.
- Search indexing delay and access-recheck refusal.
- Cache hit, miss, unsafe-write refusal and version mismatch.
- Connection failure, rate limiting, secret refresh and incoming verification failure.
- Metering event age, reconciliation lag and entitlement-policy mismatch.
- Backup age, size, off-site copy, restore result and privacy-removal replay result.

## Alerts and incident handling

Alerts are actionable and name an owner and runbook. Organisation separation, credential exposure, failed privacy removal, unrecoverable event sequence, failed backup, and production access-test failure are incidents rather than ordinary dashboard measures.

Incident records contain timeline, scope, affected organisations, containment, recovery, evidence, communication, cause, follow-up work, and verification. Customer communication follows the applicable contractual and legal requirements.

## Scheduled maintenance

`POST /api/runtime-bundles/cleanup` deletes superseded runtime bundles, expires preview installations and their retired preview storage, and removes abandoned uploads; it keeps this path because external schedulers call it. The operations scheduler calls it daily with concurrency one, holding only the protected route credential and never a database credential. The same run reclaims at most 25 expired, never-activated attachment uploads, including clean inspections awaiting Save and rejected content; failed cleanup keeps its claims and retries after five minutes. Provision the flow and route credential in every environment that accepts uploads.

## Backup

Backups cover the production [PostgreSQL](https://www.postgresql.org/docs/) database, file manifests and bytes, published definitions, flow state, configuration needed to rebuild services, and privacy-removal receipts.

- Before Production opens, Production enables [Supabase point-in-time recovery](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery) continuously with the provider's smallest available seven-day recovery window. PITR can restore to a chosen point with seconds-level granularity; it is not an hourly snapshot. The requested two-day PITR window is unavailable because Supabase currently offers seven, fourteen, or twenty-eight days.
- An independent encrypted logical backup to the Cloudflare R2 account is decided, not built. It will use a dedicated Vortex bucket or prefix and a dedicated least-privilege credential.
- The decided R2 logical-backup policy retains only the most recent 48 hours, with a lifecycle rule as a second expiry control. Cloudflare may complete lifecycle deletion up to 24 hours after expiry, so monitoring records the requested expiry and actual disappearance rather than claiming exact physical deletion at 48 hours.
- Backup objects are encrypted before upload, carry a checksum, contain no plaintext secret, and are unreadable without the separately held recovery key.
- Copies are sent to the independently controlled R2 location; no local host copy is treated as a recovery copy.
- Access is limited, logged, and tested.
- Backup retention is documented and does not silently exceed the approved privacy policy.
- A checksum and inventory prove completeness.
- A scheduled restore test creates an isolated recovery environment and never overwrites production.

### Surviving removals and revocations

The independent R2 recovery location (decided, not built) also holds an encrypted, content-free removal/revocation journal under its own prefix. This is the surviving evidence consumed by [#170](https://github.com/Abzum-NZ/Abzum-Vortex/issues/170), using the owning privacy and sharing operations; an outbox or receipt stored only in the source Supabase project cannot provide it. Entries contain operation/scope identifiers, source cluster, monotonic sequence, affected authority version, outcome and integrity evidence, never removed values, file bytes, credentials or profile details.

After authorisation, the owning operation durably records an idempotent intent outside the source project before committing its local removal/revocation. It records the committed outcome externally before reporting success. A crash between these steps leaves an explicit unresolved intent; replay keeps that scope unavailable until the outcome is established and does not infer permission from an absent completion. Retries use the same operation identifier. External-journal failure prevents a success acknowledgement; existing local restrictions remain effective. This small durability handshake is required only for removal/revocation evidence and does not introduce a general distributed transaction or another backup programme.

Each backup records a conservative replay boundary captured before its database snapshot begins, plus the unresolved intents at or below that boundary. Completion is an immutable later journal entry linked to its intent, not an in-place overwrite. Restore reconciles those earlier unresolved intents as well as all entries after the boundary; it must not assume that a pre-snapshot intent's local effect was already in the snapshot. At recovery, fence the old writers and obtain a confirmed journal high-water mark from the surviving location. Prove every sequence after the backup position through that mark is present and integrity-checked, account for both pre-boundary and later unresolved intents, and replay removals/revocations idempotently before opening affected data or access. A timestamp, latest available entry, source-project copy, or one-hour RPO is not a completeness proof. Missing entries, an unconfirmed high-water mark, or an unfenced writer keep the affected scope closed; if the missing scope cannot be identified, keep the restored environment closed.

Journal retention covers every still-restorable database/file recovery point, including the seven-day PITR window and delayed actual expiry of backup objects. It is independent of the 48-hour logical-backup cleanup and retains only the content-free evidence required to prevent restoration of removed content or authority. Purge an entry only once no retained recovery point can require it; record that eligibility in the existing retention process.

## Restore

```mermaid
sequenceDiagram
    participant Operator
    participant Backup
    participant Isolated as Isolated recovery environment
    participant Tests
    Operator->>Backup: Select verified recovery point
    Backup->>Isolated: Restore database, files and flow state
    Operator->>Isolated: Fence writers; verify surviving journal completeness
    Operator->>Isolated: Replay later removals and revocations; resolve blocked scopes
    Isolated->>Tests: Run integrity, access and application checks
    Tests-->>Operator: Recovery report
    Operator->>Isolated: Approve for declared recovery use or destroy test copy
```

The production recovery-point objective is at most one hour of accepted data loss. The recovery-time objective is at most eight hours from declaring a recoverable disaster to restoring the agreed minimum service. Continuous PITR, hourly R2 backups, alerting, runbooks, and restore drills must demonstrate both objectives; a backup job reporting success is not proof of recovery.

Supabase managed backups do not replace the independent copy because deleting or losing the provider project can also remove access to its managed recovery points. Restore drills test both the provider recovery path and the independent encrypted backup path.

## Database platform safeguards

- [SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement) is enabled for every remote database connection.
- Internal schemas are excluded from the Data API, and anonymous and signed-in browser roles have no grants on business or administrative tables. The browser uses Supabase directly only for approved Auth, private Realtime, and signed Storage flows.
- Remote connections require SSL, separate least-privilege database roles, strong rotated credentials, unexposed internal schemas, row-level rules and monitoring. [Supabase database network restrictions](https://supabase.com/docs/guides/platform/network-restrictions) accept IPv4/IPv6 CIDR ranges only and apply to direct Postgres and pooler routes; enabling them waits for stable outbound ranges from the Vercel route.
- Supabase security and performance advisers and representative [Index Advisor](https://supabase.com/docs/guides/database/extensions/index_advisor) results are reviewed in Testing and again before release. Findings become tracked work; changes are reviewed migrations, never automatic Production edits.
- Read replicas are not part of the first release and have no implementation task. A future measured scaling review may propose one only with explicit read routing, consistency expectations, cost approval, monitoring, and failure tests.

## Secret management

[Doppler](https://docs.doppler.com/docs) provides environment-scoped secrets. Secrets are never committed, copied into fixtures, printed by builds, placed in browser bundles, or included in definition exports. Rotation procedures cover application, database, storage, connection encryption keys and identity-authority signing keys. The Supabase Auth/email operator is accountable for rotating SMTP provider credentials and updating only the matching Auth configuration. The database operator is accountable for rotating each environment's `vortex_runtime` password and updating its matching Vercel-synchronised root config. The database operations operator is accountable for the project-owner and migration credentials kept only in the unsynced `Operations` environment. Each owner verifies the intended consumer after rotation before retiring the prior credential; the credential classes are never copied between runtimes. Federation rotation publishes the next public key before use, overlaps verification for in-flight messages, then removes the retired key after the replay and reconciliation windows close.

## Runbooks

At minimum, runbooks cover deployment failure, database migration failure, organisation-separation incident, lost or exposed secret, stalled event sequence, back-end run outage, file-scan outage, connection-provider outage, entitlement or metering mismatch, search delay, backup failure, complete restore, protected-removal failure and provider-region failure.

## Acceptance examples

- The measured restore point is no more than one hour before the declared incident, and the agreed minimum service is restored within eight hours.
- Recovery succeeds from an independent copy even when the original Supabase project is unavailable.
- PITR can restore to a selected point inside its seven-day window, and the hourly R2 path can restore while treating Supabase-managed recovery as unavailable.
- R2 backup inventory never contains a successful Vortex logical backup whose requested expiry is more than 48 hours old without an alert and cleanup retry.
- A log scan finds no credentials or sensitive values in successful and failing paths.
- Every production alert links to a tested runbook and an accountable owner.


