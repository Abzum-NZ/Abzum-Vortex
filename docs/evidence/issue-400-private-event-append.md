# Private transactional Event append evidence

Task: [#400](https://github.com/Abzum-NZ/Abzum-Vortex/issues/400). Normative
behavior: [Event delivery guarantees](../specification/08-forms-actions-rules-and-events.md#delivery-guarantees)
and the [save/Event boundary](../build-plan/module-record-provisioning.md#event-append-authority).

## Delivered boundary

The forward migration enables the Supabase image's bundled `pgmq` extension if it
is available, without pinning or upgrading it. It creates exactly one Basic logged
queue, `vortex_event_occurrences`, and one private immutable outbox. An unavailable
bundled extension fails migration explicitly; there is no alternate queue or
external infrastructure fallback.

The sole write operation is
`vortex_event.append_record_occurrences(uuid, uuid, jsonb)`. It is a fixed
`SECURITY DEFINER` helper owned by `postgres` and executable only by the existing
non-login `vortex_record_adapter`. Browser, Data API, request and runtime roles
cannot call it, read or change the outbox, or use the raw `pgmq` queue. Existing
request-role access to Module's read-only current-installation operation is
unchanged.

The helper accepts only the actual storage/record target and a closed occurrence
batch containing occurrence identity, installed descriptor and payload. Verified
request context and installed Definition evidence supply organisation,
Application, Module release, actor and correlation. The database supplies time
and sequence. Callers cannot supply queue, actor, correlation, release, sequence,
causation or validation-success claims.

The helper takes the shared form of the canonical Module lifecycle lock and then
rereads the exact active installation, binding and release. Lifecycle mutations
take the exclusive form of that lock, so a waiting append cannot use stale
installation evidence. The actual generated Record row must be returned and is
locked before sequence allocation. Sequence is indexed by organisation, actual
storage and record; Application is included only for application-contained
storage. Consequently an organisation-shared record has one sequence across all
consuming Applications, while different records in the same Application and
Module remain independent. Every V2 outbox envelope and its minimum queue message
`{contractVersion, occurrenceId}` are appended in the caller's transaction.

## Database objects and privileges

| Object | Boundary |
|---|---|
| `vortex_event.event_outbox` | Forced RLS, no policies, immutable update/delete trigger and no application/Data API grants |
| `pgmq.q_vortex_event_occurrences` and archive | Logged tables, forced RLS and no application/Data API/Record-adapter grants |
| `vortex_event.append_record_occurrences` | Execute only for `vortex_record_adapter`; PUBLIC and all request/runtime/Data API roles are revoked |
| Existing active-installation reader | Internal execute for the helper owner; its pre-existing request/adapter read boundary is preserved |
| Generated `record_data` tables | Internal helper-owner `SELECT, UPDATE` for the real row lock, including future generated tables; forced RLS and all caller ACLs remain unchanged |

No public Event API, dispatcher, consumer, delivery-progress state, retry policy,
receipt-retention default, Kestra change, second business evaluator, Event counter
or business-domain behavior is part of this task. Those delivery behaviors remain
[#60](https://github.com/Abzum-NZ/Abzum-Vortex/issues/60); the complete public save
remains [#47](https://github.com/Abzum-NZ/Abzum-Vortex/issues/47).

## Focused verification

| Proof | Result |
|---|---|
| `485_private_event_append.test.sql` | 51/51 assertions pass against real published/provisioned/installed storage |
| `event-append-concurrency.test.sh` | Same shared record serializes across two consuming Applications; a different record in the same Application/Module proceeds independently; a real detach makes the waiting append reread and safe-refuse |
| `event-append-postgres.integration.test.ts` | One declared and one standard occurrence from a real compiler-produced Module/Application, publication, provisioning and installation append together and decode with the existing V2 validator (1/1) |

The database suite additionally proves an empty batch has no effects; a missing
record and a record contained by another Application create no effect; contained
records keep Application scope; an inactive, detached or substituted installation,
wrong storage and undeclared descriptor are refused; duplicate identities within
one batch roll back the whole batch; null or malformed required V2 discriminators
and identities are refused; a duplicate in a later batch item rolls back the
earlier outbox and queue append; a forced queue failure rolls back the surrounding
Record write; standard and declared custom privacy rules refuse values that are
not allowed; outbox evidence is immutable; and raw queue/helper/table authority is
absent from request, runtime and Data API roles.

## Complete local verification

The first implementation passed `pnpm verify` and one complete fresh database run,
but independent review then found missing-row, lifecycle-race, lock-scope and
null-shape gaps. After correction, `pnpm verify` passes formatting, lint, all 23
package typechecks and builds, package-boundary validation, 148 test files with
1,868 passing tests, and 18 fixture checks. A fresh database run applied all 91
migrations and passed all 77 SQL files with 3,746 assertions, including this
task's 51 assertions; all three compiler-to-PostgreSQL integrations and all 29
concurrency proofs passed. Database lint completed across all ten listed schemas,
including `vortex_event`, with only the repository's pre-existing Access warnings.

Two later repetitions of the earlier full gate exposed a Group-administration
final-steward failure and a role-change stale-evidence failure. Both Access tests
are unchanged from `origin/testing`; one bounded reproduction on the corrected
branch passed all 45 Group assertions and the complete role-change concurrency
proof. The failures did not reproduce, and the Event patch changes no Access
operation. This task does not mask either failure or broaden Event behavior to
compensate for it.

Independent GPT-6 Astra review approved the corrected implementation in
[PR #427](https://github.com/Abzum-NZ/Abzum-Vortex/pull/427), merged to Testing as
`769cb11d263ddd5f689558cc9d704813c98be8e5`. Read-only hosted history inspection
confirmed that Testing has applied migrations `20260913010000` and
`20260913030000`, but not this task's earlier `20260912192054`. The hosted runner
refuses this older pending migration under its current ordering rule. Fresh-local
success therefore does not prove the existing Testing database's upgrade path.
The migration-order repair tracked by
[consolidation PR #419](https://github.com/Abzum-NZ/Abzum-Vortex/pull/419) must be
reviewed and applied before exact hosted Testing verification can complete.
Hosted verification remains pending; review approval does not establish delivery.
