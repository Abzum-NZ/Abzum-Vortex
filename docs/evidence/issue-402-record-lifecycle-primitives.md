# Issue #402 — private record lifecycle primitives

[Issue #402](https://github.com/Abzum-NZ/Abzum-Vortex/issues/402) ·
[record lifecycle](../specification/06-records-and-lifecycle.md) ·
[module storage plan](../build-plan/module-record-provisioning.md)

## Delivered boundary

This change adds the private storage operations that the later protected save
pipeline composes. It does not add a browser, MCP or public database write
endpoint. The request and runtime roles cannot call the new functions or write
the generated record tables, reference counters, data versions or relationship
edges directly.

The implementation is generic: every table, field, relationship, permission and
ownership decision comes from the exact active installation, its published
Module definition and Record's protected storage catalogue. No application or
business-domain name is present in the engine.

## Implementation matrix

| Object | Responsibility and caller |
| --- | --- |
| `record_reference_counters` | Record-owned, forced-RLS counter state. Its null-safe unique key is organisation + storage contract + field + applicable application root. Only the private Record adapter uses it. |
| `record_data_versions` | Record-owned, forced-RLS invalidation version per exact storage scope. Accepted mutations increment it and refuse numeric exhaustion. |
| `lock_current_record_owner_group_internal` | Access-owned narrow check called only by the Record adapter. It locks the selected active same-organisation Group and the effective human account's current membership. |
| `resolve_record_action_context_internal` | Resolves trusted human context, the matching record type across every exact active Module binding, current release, protected storage mappings and the action's Access declaration. Used only by the #402 primitives. |
| `allocate_reference_number_internal` | Uses the published start, prefix, suffix and minimum digit width under one atomic counter upsert. Omitted start means one; a wider number is never truncated. |
| `write_relationship_value_internal` | Validates the exact published single target, locks it and rechecks its current read eligibility, then changes the source link and canonical edge atomically. One-to-one additionally prevents another source using the target. |
| `create_record_internal` | Derives scope, audit facts and account ownership, or checks the selected current Group. It bounds submitted fields, allocates references, validates required values and performs the typed write plus relationship edges atomically. |
| `change_record_relationship_internal` | Locks the source at the expected revision, applies current update Access and field bounds, then invokes the exact relationship writer. |
| `soft_delete_record_recursive_internal` | Applies the published incoming-link action in stable order. It checks current authority for every affected child, rechecks the current source link after its row lock and changes child/parent state atomically. |
| `soft_delete_record_internal` | Fixed revision-checked recoverable-delete entry point. It exposes only completed, conflict or non-disclosing refusal outcomes to its future owning caller. |
| `restore_record_internal` | Loads the restore action's retained facts at the expected revision, rechecks current restore Access, required non-link presence/canonical storage shape, and exact required fixed-target value/edge consistency, then locks and rechecks each active readable target before restoring the same row. Full final-value settings validation remains [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47). |

## Correctness found during implementation

- The earlier local data-version upsert could return the maximum value again
  instead of refusing exhaustion. The new fixed increment returns no row at the
  maximum and raises an exact numeric-overflow failure so ordering cannot stall.
- A parent deletion can open its incoming-edge cursor before a concurrent link
  clear commits. Merely locking the child afterward is insufficient because the
  cursor may still describe the old edge. The delete now reads the exact current
  owning link value with the child row lock and skips an edge that has already
  been removed or redirected. This prevents a second child revision and preserves
  the single atomic relationship result.
- The inherited facts loader was structurally action-generic but rejected every
  selector except read/update. The migration extends that exact owned function
  in place with a source-text drift guard, so create/delete/restore build their
  closure from their own route declarations without copying a second facts
  engine.
- Dynamic SQL does not change PL/pgSQL's `FOUND` flag. Target locks now capture
  the selected result explicitly and eligibility is rebuilt after the lock;
  restore applies the same lock-and-recheck rule to every required target.
- PostgreSQL may queue a second waiter behind the first waiter on the same tuple,
  so the concurrency proof follows the complete blocker chain instead of assuming
  both waiters name the original holder directly.

## Verification evidence

- `475_record_adapters.test.sql`: **107/107** focused assertions on a real
  published and provisioned fixture. Coverage includes account/Group/ownerless
  create, required and bounded fields, exact audit/definition facts, default and
  multi-Module resolution, explicit/wider reference starts, 99-to-100 growth,
  rollback, target eligibility, edge exactness,
  one-to-one cardinality, all three parent-delete actions, child permissions,
  retained restore checks and raw/private bypass refusal.
- `record-change-concurrency.test.sh`: passed the four #402 races plus the existing
  change races. Two simultaneous creates produced unique `RC-001` and `RC-002`;
  concurrent link clear and target delete finished with the target soft-deleted at
  revision 2, the source active at revision 2 with a null link, and zero stale
  edges. A target delete won before a waiting link add, which refused without an
  edge or source revision; a required target delete won before a waiting restore,
  which left the source recoverably deleted. The stale-update conflict and
  authority-revocation races also passed.
- `pnpm db:verify`: **76/76 SQL files and 3,695/3,695 assertions** passed on a
  fresh isolated database; its two verification-tool tests and all **28**
  concurrency scripts passed, including the #402 proof. Database advisers
  completed with only the existing warnings in older Access functions and no
  finding in the new Record objects.
- `pnpm verify`: formatting, lint, all 23 package type checks, package boundaries,
  **148 passed test files / 1,868 passed tests** (four files and five tests
  intentionally skipped), **18/18 fixture tests**, and all 23 package builds
  passed, including the Next.js production build.

Independent GPT-6 Astra review approved the corrected implementation in
[PR #426](https://github.com/Abzum-NZ/Abzum-Vortex/pull/426), merged to Testing as
`6c7837d`. Exact hosted Testing verification remains pending before issue closure.

## Explicitly not delivered

- The public save command, Activity/Event effects, calculations, totals and
  command receipts remain [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47)
  and their named engine owners.
- System or specified-account execution remains
  [#322](https://github.com/Abzum-NZ/Abzum-Vortex/issues/322); no human identity or
  target owner is fabricated here.
- The public create command's Group input remains #47. This primitive receives
  only the closed selected Group identifier at the storage-operation boundary.
- Ownership transfer/offboarding remains
  [#407](https://github.com/Abzum-NZ/Abzum-Vortex/issues/407).
- Lifecycle-policy defaults, recovery-window enforcement and scheduling remain
  [#408](https://github.com/Abzum-NZ/Abzum-Vortex/issues/408) and
  [#117](https://github.com/Abzum-NZ/Abzum-Vortex/issues/117).
- Polymorphic target resolution and broader relationship integration remain
  [#49](https://github.com/Abzum-NZ/Abzum-Vortex/issues/49). This slice supports
  the existing single-target to-one facts and does not create a hidden
  many-to-many edge engine.
