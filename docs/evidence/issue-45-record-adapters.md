# Fixed record adapters over provisioned storage — implementation evidence

Task: [#401](https://github.com/Abzum-NZ/Abzum-Vortex/issues/401), the first
slice of [#45](https://github.com/Abzum-NZ/Abzum-Vortex/issues/45). Plan and
design decisions: #401's Behaviour and Design sections, and the #45 planning
pass of 12 September 2026.

Branch `feat/issue-45-record-adapters`, started from Testing `2b9785a`
(PR #406, documentation only). Pushed with no pull request. Local evidence only:
no hosted Testing run and no independent review exist for it yet.

## What landed

Two migrations, both created with `pnpm db:new`.

`20260912011550_accept_compiled_record_ownership_mode.sql` replaces the storage
provisioner under its existing owner and changes exactly two lines: the accepted
ownership values, and the generated owner check's Group branch. The compiler
emits `team` for a Group-owned record type and cannot emit the runtime term
`group`, so every compiled Module release carrying one was refused with 42501.
`team` is accepted instead of, not alongside, `group`. The remainder of the
function is byte-identical to the delivered `20260909101526`, verified by diff,
so its signature, volatility, security mode, empty search path, owner, grants and
ACL are unchanged. No published release can contain `group`, so no stored
catalogue row, fingerprint or generated table changes.

`20260912011556_fixed_record_adapters.sql` adds the fixed pair and what they
need:

- `vortex_record.read_record(uuid, uuid)` returns the readable field projection
  of one record, or `{"outcome":"refused"}` — identical for a missing record, a
  record of another organisation or application, and a record no held route
  reaches, so it is no existence oracle.
- `vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])` locks the
  row, refuses a stale concurrency number as `conflict`, evaluates the update
  decision on the old row and on the proposed row, enforces the changeable-field
  bound over the submitted field identifiers beside the write, writes the typed
  columns with `concurrency_number + 1` and the change stamp from the verified
  context and the installed binding, and returns the readable projection.
- A private facts loader and a pure canonical-value check, both private to the
  pair.
- `vortex_access.resolve_record_field_bounds_internal` becomes `SECURITY
  DEFINER` under its existing owner, body unchanged.

Both adapters are `SECURITY DEFINER` owned by `vortex_record_adapter`, so their
DML remains subject to the existing scope policies rather than bypassing them.
The row policies stay scope-only; the complete exact-record decision runs inside
the adapter.

## Privilege change

| Object | Before | After |
| --- | --- | --- |
| `resolve_record_field_bounds_internal(jsonb)` | invoker rights; ACL `postgres` only | definer rights; ACL `postgres`, `vortex_record_adapter` |
| `evaluate_organization_record_access_internal(jsonb,uuid,jsonb)` | definer; ACL `postgres` only | unchanged mode; ACL `postgres`, `vortex_record_adapter` |
| `vortex_record_adapter` schemas | `vortex_record`, `record_data`, `vortex_context` | adds usage on `vortex_access`, `vortex_definition`, `vortex_module` |
| `vortex_record_adapter` functions | three context accessors | adds `validated_human_request_context()`, the record decision, the field-bounds resolver, `read_current_active_installation()` |
| `vortex_record_adapter` tables | DML on generated record tables | adds select, through new policies, on the storage catalogue, field and relationship mappings, release provisions, `relationship_edges` (own organisation only) and `vortex_definition.releases` |
| `vortex_request` | no privilege in `vortex_record` | adds usage on schema `vortex_record` and execute on `read_record` alone; still no table privilege anywhere |

No `record_data` row-policy expression changed. `475` asserts that every
generated record table still carries exactly four policies, all to
`vortex_record_adapter`, and that `vortex_request` holds no privilege on any of
them. The adapter owner holds no privilege on any Access table and is granted
none; it also cannot execute either provisioner. The row-scope composer keeps no
grant at all, including for that role.

Nothing in the adapters calls a helper outside that exact list. The nil-UUID and
temporal shape checks are inline rather than borrowed from
`vortex_context.is_non_nil_uuid` or
`vortex_access.typed_condition_temporal_value_internal`, because reaching either
would have meant widening the grant list #401 fixes.

## Proofs

`supabase/tests/475_record_adapters.test.sql`, 46 assertions, under the real
`vortex_request` role with `set local role vortex_record_adapter` for
`change_record`:

| Acceptance | Covered by |
| --- | --- |
| (a) matrix in both organisation and both application directions | two organisations, three Applications, two Modules; both Applications of the first bind the same Module release, so the application direction runs over one shared physical table |
| (b) withheld field absent, identical refusals | the never-named field is absent from every projection; missing, foreign and unreachable records return the same `{"outcome":"refused"}` |
| (c) whole-change refusals | one permitted plus one forbidden submitted field refuses and the row is proved byte-identical; a non-submitted generated value outside the changeable set is accepted; unknown field, system column, link field, non-canonical decimal and ill-typed value each refuse with their own code |
| (d) stale concurrency | returns `conflict` naming the current number and writes nothing |
| (e) proposed-row decision | flipping the condition field is refused on the proposed row after the old row admitted it |
| (f) relationship route | a relationship-routed permission admits the linked record; the incomplete-facts guard is proved by mutation M6 |
| (g) column types | every storage column type round-trips as canonical V2 JSON, including a date-time written at `+13:00` and read back as the same instant in UTC |
| (i) boundary inventory | the privilege table above |

`supabase/tests/record-change-concurrency.test.sh`, registered in
`workflows/kestra/database-verification.json` against the adapters migration,
runs two races through two sessions:

- two changes carrying the same expected number: the second blocks on the row
  lock, returns `conflict` once the first commits, and exactly one write lands
  (`2|first writer`);
- a role-assignment revocation commits while a change waits at that lock: the
  change is refused with 42501 and writes nothing (`1|start`).

Fixture honesty: releases come from `vortex_definition.append_release`, the
permission catalogues from the coordinated Access registration, the Group, roles
and assignments from their owning writers, and the storage from the Module
coordinator. Binding activation (#43), record rows (#402), the relationship edge
(#402) and the direct share (#36's private structural writer) are labelled direct
writes, because no writer for them exists yet.

## Mutations

Each on a fresh cluster, with the tree restored and verified byte-identical
afterwards.

| Mutation | Result |
| --- | --- |
| M1a accepted ownership list widened to both spellings | `455` fails 2/45; the wire-parity vitest fails 1/16 |
| M1b owner-check Group branch keyed to the stale term | `455` aborts on `rt_64550000000040008000000000000001_check`; 26/45 run, 19 lost |
| M2 resolver security mode and both adapter execute grants removed | `430` fails 2/130 (22–23); `440` fails 3/25 (2, 11–12) |
| M3 proposed-row decision skipped (old row decided twice) | `475` fails 6/46 (38–39 directly, 40–43 cascading) |
| M4 submitted-field bound removed | `475` fails 8/46 (30–31 directly, 32–34 and 37–39 cascading) |
| M5 stale-concurrency check removed | `475` aborts with "Record change did not apply to exactly one row"; 35/46 run, 11 lost |
| M6 facts loader made incomplete (saved conditions dropped) | `475` aborts with 22023 "Record access facts are invalid"; 27/46 run, 19 lost |
| M7 resolver execute grant widened to `vortex_request` | five suites fail: `440` 2/25, `445`, `447`, `450` one each, `475` 1/46 |
| P1 conflict check removed | the concurrency proof fails at "the waiting change failed" |
| P2 target-row lock removed | the second change no longer serialises; the proof fails the same way |

`475` itself exposed two defects in the adapters, both fixed before it passed:
the adapters depended on two helpers the adapter role may not execute, and the
declaration filter tested `-> 'namedAction' is null` where `jsonb_build_object`
stores an absent key as JSON null, so no alternative was ever named and every
record refused.

## Local verification

- `pnpm db:verify` on a fresh cluster exited 0: pgTAP `Files=75, Tests=3535,
  Result: PASS`; all 28 concurrency proofs passed; database lint completed over
  the nine manifest schemas with 10 warnings and no error, every warning in a
  function this branch does not touch.
- `pnpm verify`: `format:check`, `lint`, `typecheck` and `boundaries` pass. The
  test stage stops only on [#390](https://github.com/Abzum-NZ/Abzum-Vortex/issues/390)'s
  two compiler timeouts; those two files pass 84/84 when run alone. `fixtures`
  passes 18/18 and `build` 23/23.
- One earlier `db:verify` attempt failed at the pre-existing Module storage
  provisioning proof's 20-second blocking barrier. That proof passed in both
  `db:concurrency` runs and in the clean re-run, and this branch changes only a
  fixture literal in it, so it is recorded as a load-related timing flake rather
  than a defect. It is named here rather than omitted.

## Not proved

- Acceptance (h), a saved condition over a V2 money field.
  [#399](https://github.com/Abzum-NZ/Abzum-Vortex/issues/399) is open: the
  database saved-condition evaluator still compares V2 decimal and money as
  double-precision JSON numbers. The saved condition this suite uses names a
  `yes_no` field, which that evaluator handles correctly. #45 cannot close
  without (h).
- Polymorphic relationships (`toRecordTypes`) are not represented in the facts,
  because the #35 facts contract carries one `toRecordTypeId` per relationship
  identity. They are omitted, so a route or ownership chain over one refuses
  rather than resolving against the wrong target. S2 owns edge writes and can
  revisit the shape.
- The two organisations in `475` hold separate storage contracts, so its
  cross-organisation evidence is that a record identifier does not cross
  organisations. Two organisations sharing one physical table remains `455`'s
  proof, because the publication writer keeps an Application's dependency
  closure inside its own organisation.
- Create, delete, restore, reference numbers and relationship-edge writes
  (#402); activation (#43); save, receipts, Activity and events (#47, #400);
  system-metadata projection (#50); query predicates (#54); and TypeScript
  repository wrappers are all out of scope here and absent.
- No hosted Testing receipt and no independent review exist for this branch.
