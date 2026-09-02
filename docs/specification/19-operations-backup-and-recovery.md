# 19. Operations, backup and recovery

[Previous: Delivery environments, database changes and testing](18-delivery-and-testing.md) · [Specification index](README.md) · Next: [Quality, accessibility and acceptance](20-quality-and-acceptance.md)

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
- Workflow start, wait, retry, failure, callback mismatch and reconciliation difference.
- File scan, quarantine, storage and removal backlog.
- Search indexing delay and access-recheck refusal.
- Cache hit, miss, unsafe-write refusal and version mismatch.
- Connection failure, rate limiting, secret refresh and incoming verification failure.
- Federation request rate, source latency, timeout, signature refusal, replay refusal, incompatible version, grant-reconciliation age, and recipient-mirror difference by source and recipient cluster.
- Billing event age, usage reconciliation and entitlement mismatch.
- Backup age, size, off-site copy, restore result and privacy-removal replay result.

## Alerts and incident handling

Alerts are actionable and name an owner and runbook. Organisation separation, credential exposure, failed privacy removal, unrecoverable event sequence, failed backup, and production access-test failure are incidents rather than ordinary dashboard measures.

Incident records contain timeline, scope, affected organisations, containment, recovery, evidence, communication, cause, follow-up work, and verification. Customer communication follows the applicable contractual and legal requirements.

## Backup

Backups cover the production [PostgreSQL](https://www.postgresql.org/docs/) database, file manifests and bytes, published definitions, [Kestra](https://kestra.io/docs) workflow definitions and required state, configuration needed to rebuild services, and privacy-removal receipts.

- Before Production opens, Production enables [Supabase point-in-time recovery](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery) continuously with the provider's smallest available seven-day recovery window. PITR can restore to a chosen point with seconds-level granularity; it is not an hourly snapshot. The requested two-day PITR window is unavailable because Supabase currently offers seven, fourteen, or twenty-eight days.
- Independently of PITR, Kestra creates an encrypted logical Vortex database backup every hour and sends it to the existing Cloudflare R2 backup account under a dedicated Vortex bucket or prefix and dedicated least-privilege credential. It does not mix Vortex objects with the Kestra database prefix.
- The R2 logical-backup policy retains only the most recent 48 hours. An hourly Kestra cleanup removes older objects and an [R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) provides a second expiry control. Cloudflare may complete lifecycle deletion up to 24 hours after expiry, so monitoring records the requested expiry and actual disappearance rather than claiming exact physical deletion at 48 hours.
- Backup objects are encrypted before upload, carry a checksum, contain no plaintext secret, and are unreadable without the separately held recovery key.
- Copies are sent to the independently controlled R2 location; no local Kestra-host copy is treated as a recovery copy.
- Access is limited, logged, and tested.
- Backup retention is documented and does not silently exceed the approved privacy policy.
- A checksum and inventory prove completeness.
- A scheduled restore test creates an isolated recovery environment and never overwrites production.

## Restore

```mermaid
sequenceDiagram
    participant Operator
    participant Backup
    participant Isolated as Isolated recovery environment
    participant Tests
    Operator->>Backup: Select verified recovery point
    Backup->>Isolated: Restore database, files and workflow state
    Operator->>Isolated: Apply later privacy-removal receipts
    Isolated->>Tests: Run integrity, access and application checks
    Tests-->>Operator: Recovery report
    Operator->>Isolated: Approve for declared recovery use or destroy test copy
```

The production recovery-point objective is at most one hour of accepted data loss. The recovery-time objective is at most eight hours from declaring a recoverable disaster to restoring the agreed minimum service. Continuous PITR, hourly R2 backups, alerting, runbooks, and restore drills must demonstrate both objectives; a backup job reporting success is not proof of recovery.

Supabase managed backups do not replace the independent copy because deleting or losing the provider project can also remove access to its managed recovery points. Restore drills test both the provider recovery path and the independent encrypted backup path.

## Database platform safeguards

- [SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement) is enabled for every remote database connection.
- Internal schemas are excluded from the Data API, and anonymous and signed-in browser roles have no grants on business or administrative tables. The browser uses Supabase directly only for approved Auth, private Realtime, and signed Storage flows.
- [Supabase database network restrictions](https://supabase.com/docs/guides/platform/network-restrictions) are configured in the Supabase dashboard or CLI and accept IPv4/IPv6 CIDR ranges only. They cannot allow a DNS name such as `kestra.abzum.com`, do not apply per database role, and apply to both direct Postgres and pooler routes.
- Network restrictions are deferred until the Vercel server route has stable outbound IP ranges or an equivalent private route. At that point Production allowlists both the Kestra host's fixed outbound IP ranges and Vercel's fixed egress ranges. Allowlisting only Kestra while Vercel still connects to PostgreSQL would break the application and is refused.
- Until that later hardening, remote connections require SSL, separate least-privilege database roles, strong rotated credentials, unexposed internal schemas, row-level rules, and monitoring. This deferment belongs to [Phase 13](../build-plan/README.md#phase-13--operational-readiness-and-release), not Phase 1.
- Supabase security and performance advisers and representative [Index Advisor](https://supabase.com/docs/guides/database/extensions/index_advisor) results are reviewed in Testing and again before release. Findings become tracked work; changes are reviewed migrations, never automatic Production edits.
- Read replicas are not part of the first release and have no implementation task. A future measured scaling review may propose one only with explicit read routing, consistency expectations, cost approval, monitoring, and failure tests.

## Secret management

[Doppler](https://docs.doppler.com/docs) provides environment-scoped secrets. Secrets are never committed, copied into fixtures, printed by builds, placed in browser bundles, or included in definition exports. Rotation procedures cover application, database, storage, [Kestra](https://kestra.io/docs), [Stripe](https://docs.stripe.com/), connection encryption keys, identity-authority signing keys, and cluster federation signing keys. Federation rotation publishes the next public key before use, overlaps verification for in-flight messages, then removes the retired key after the replay and reconciliation windows close.

## Support access

Support access requires a named operator role, strong sign-in, a ticket, purpose, organisation approval where feasible, expiry, and activity entry visible to the organisation. Default support access is read-only impersonation of an existing permitted view. Any change requires separate approval and uses an ordinary named action.

## Runbooks

At minimum, runbooks cover deployment failure, database migration failure, organisation-separation incident, lost or exposed secret, stalled event sequence, workflow outage, file-scan outage, connection-provider outage, billing mismatch, search delay, backup failure, complete restore, privacy-removal failure, provider-region failure, federation signing-key exposure, one-cluster outage, incompatible federation release, cluster-directory error, and grant-mirror reconciliation backlog.

## Acceptance examples

- A restore drill proves records, files, definitions, workflow state, and removal receipts together.
- The measured restore point is no more than one hour before the declared incident, and the agreed minimum service is restored within eight hours.
- A backup stored only on the [Kestra](https://kestra.io/docs) host is refused as incomplete protection.
- Recovery succeeds from an independent copy even when the original Supabase project is unavailable.
- PITR can restore to a selected point inside its seven-day window, and the hourly R2 path can restore while treating Supabase-managed recovery as unavailable.
- R2 backup inventory never contains a successful Vortex logical backup whose requested expiry is more than 48 hours old without an alert and cleanup retry.
- A log scan finds no credentials or sensitive values in successful and failing paths.
- Support access expires automatically and appears in the organisation's activity.
- Every production alert links to a tested runbook and an accountable owner.
- Disabling one cluster's federation route stops new remote requests without requiring database credential rotation in every other cluster.
- Restoring a source cluster replays later grant revocations and privacy-removal receipts before cross-cluster access is reopened.
