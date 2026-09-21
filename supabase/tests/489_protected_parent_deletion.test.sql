\ir helpers/definition-release-writer.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #49: one protected, recoverable parent delete composed with #48's concrete
-- relationship totals, over a real published, provisioned and activated
-- installation.
--
-- The database owns selection, scope, locking, the affected-record set and
-- every validation proved here. The pure evaluator that turns a prepared
-- closure into final generated values is delivered in TypeScript and is proved
-- by its own unit tests, so this suite supplies the final values explicitly and
-- asserts that the writer accepts only the exact prepared shape.
--
-- Acceptance coverage, in order below:
--   1. restricted callers cannot invoke the private primitives;
--   2. a required (`refuse`) link refuses the parent deletion and nothing
--      changes -- no row, edge, revision, generated value, Activity, Event or
--      receipt effect;
--   3. a caller who lacks current authority on an affected record is refused
--      without the refusal identifying or describing that record;
--   4. a prepared but unfinalized command cannot reach commit;
--   5. the cascade soft deletes the dependent and its nested dependant, clears
--      the optional link on the surviving child, and prepares every surviving
--      affected record from the private journal alone;
--   6. every surviving parent of every soft-deleted record keeps an
--      authoritative total, written through the owning generated-value writer;
--   7. duplicate command refusal is preserved the way the save path preserves
--      it;
--   8. the private delete-mode preparation cannot be driven without a scoped
--      pending journal, so no caller can supply a deleted identity.
-- ============================================================================

\ir helpers/protected-parent-delete-fixture.psql

\set command_refuse 'c4950000-0000-4000-8000-000000000201'
\set command_scoped 'c4950000-0000-4000-8000-000000000202'
\set command_pending 'c4950000-0000-4000-8000-000000000203'
\set command_delete 'c4950000-0000-4000-8000-000000000204'
\set command_unknown 'c4950000-0000-4000-8000-000000000205'
\set activity_refuse 'c4950000-0000-4000-8000-000000000301'
\set activity_scoped 'c4950000-0000-4000-8000-000000000302'
\set activity_pending 'c4950000-0000-4000-8000-000000000303'
\set activity_delete 'c4950000-0000-4000-8000-000000000304'
\set occurrence_delete 'c4950000-0000-4000-8000-000000000401'

-- ---------------------------------------------------------------------------
-- 1. The protected boundary.
-- ---------------------------------------------------------------------------

select ok(
  has_function_privilege('vortex_runtime',
    'vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid)'::regprocedure,
    'EXECUTE'),
  'runtime may invoke the protected parent delete preparation'
);
select ok(
  has_function_privilege('vortex_runtime',
    'vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'),
  'runtime may invoke the terminal parent delete writer'
);
-- The delete mode is an overload of the existing preparation engine. Overloads
-- carry their own privileges, so the create/update grant must not reach it.
select ok(
  has_function_privilege('vortex_runtime',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::regprocedure,
    'EXECUTE'),
  'runtime keeps its existing create/update relationship-total preflight'
);
select ok(
  not has_function_privilege('vortex_runtime',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'),
  'runtime cannot invoke the adapter-private delete-mode preparation overload'
);
select ok(
  not has_function_privilege('vortex_request',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE')
  and not has_function_privilege('service_role',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'),
  'no request or service role can supply a deleted-record input to the preparation engine'
);
select ok(
  has_function_privilege('vortex_record_adapter',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'),
  'the adapter owns the delete-mode preparation overload'
);
select ok(
  not has_function_privilege('vortex_runtime',
    'vortex_record.delete_command_closure_internal(jsonb,uuid,uuid,uuid)'::regprocedure,
    'EXECUTE'),
  'runtime cannot invoke the private delete closure'
);
select ok(
  not has_function_privilege('vortex_runtime',
    'vortex_record.delete_command_deleted_records_internal(uuid)'::regprocedure,
    'EXECUTE'),
  'runtime cannot read this command''s deleted-record derivation'
);
select ok(
  not has_function_privilege('vortex_runtime',
    'vortex_record.append_pending_delete_effect_internal(text,uuid,uuid,uuid,bigint,uuid,uuid,jsonb,jsonb)'::regprocedure,
    'EXECUTE'),
  'runtime cannot write the private delete effect journal'
);
select ok(
  not has_function_privilege('vortex_request',
    'vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid)'::regprocedure,
    'EXECUTE'),
  'the restricted request role cannot invoke the protected parent delete'
);
select ok(
  not has_function_privilege('service_role',
    'vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'),
  'the service role cannot bypass the protected parent delete service'
);
select ok(
  not has_function_privilege('vortex_runtime',
    'vortex_record.soft_delete_record_internal(uuid,uuid,bigint)'::regprocedure, 'EXECUTE'),
  'the private lifecycle primitive stays unreachable from the request runtime'
);
select ok(
  not has_table_privilege('vortex_runtime', 'vortex_record.delete_command_receipts', 'SELECT')
  and not has_table_privilege('vortex_runtime', 'vortex_record.delete_command_effects', 'SELECT'),
  'runtime cannot read the private delete receipts or effect journal'
);
select ok(
  not has_table_privilege('vortex_request', 'vortex_record.delete_command_effects', 'SELECT')
  and not has_table_privilege('service_role', 'vortex_record.delete_command_effects', 'SELECT'),
  'no request or service role can read the private delete effect journal'
);
select is(
  (select pg_catalog.count(*) from pg_catalog.pg_policy policy
   join pg_catalog.pg_class relation on relation.oid = policy.polrelid
   where relation.relname in ('delete_command_receipts', 'delete_command_effects')),
  2::bigint,
  'both private delete tables carry exactly their adapter row policy'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class
   where oid = 'vortex_record.delete_command_receipts'::regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class
   where oid = 'vortex_record.delete_command_effects'::regclass),
  'row security is enabled and forced on both private delete tables'
);

-- ---------------------------------------------------------------------------
-- 2. A published `refuse` link refuses the parent deletion, and nothing
--    changes anywhere.
-- ---------------------------------------------------------------------------

select pg_temp.delete_context(:'app'::uuid, :'full_account'::uuid);
set local role vortex_runtime;
select vortex_record.prepare_protected_parent_delete(
  :'command_refuse'::uuid, :'parent_type'::uuid, :'refused_parent_record'::uuid,
  1, :'activity_refuse'::uuid)::text as refuse_result \gset
reset role;

select is(
  (:'refuse_result'::jsonb) ->> 'outcome', 'refused',
  'a required link refuses the parent deletion'
);
select is(
  (:'refuse_result'::jsonb) ->> 'reasonCode', 'relationship_refused',
  'the refusal carries the published relationship reason and no record detail'
);
select ok(
  (:'refuse_result'::jsonb)::text not like ('%' || :'guard_record' || '%'),
  'the refusal never identifies the blocking record'
);
select is(
  (select pg_catalog.count(*) from vortex_record.delete_command_receipts
   where command_id = :'command_refuse'::uuid),
  0::bigint,
  'a refused parent deletion leaves no command receipt'
);
select is(
  (select pg_catalog.count(*) from vortex_record.delete_command_effects),
  0::bigint,
  'a refused parent deletion leaves no journal effect'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number,
     'deletedAt', stored.deleted_at)
   from record_data.rt_b4950000000040008000000000000001 as stored
   where stored.record_id = :'refused_parent_record'::uuid),
  pg_catalog.jsonb_build_object(
    'lifecycleState', 'active', 'concurrencyNumber', 1, 'deletedAt', null),
  'the refused parent keeps its exact row, revision and lifecycle state'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number,
     'parentLink', stored.f_f4950000000040008000000000000012)
   from record_data.rt_b4950000000040008000000000000002 as stored
   where stored.record_id = :'guard_record'::uuid),
  pg_catalog.jsonb_build_object(
    'lifecycleState', 'active', 'concurrencyNumber', 1,
    'parentLink', pg_catalog.jsonb_build_object(
      'recordTypeId', :'parent_type', 'recordId', :'refused_parent_record')),
  'the blocking child keeps its exact row, revision and link value'
);
select is(
  (select pg_catalog.count(*) from vortex_record.relationship_edges
   where to_record_id = :'refused_parent_record'::uuid),
  1::bigint,
  'a refused parent deletion leaves its exact incoming edge in place'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
   where activity_id = :'activity_refuse'::uuid),
  0::bigint,
  'a refused parent deletion appends no Activity'
);
select is(
  (select pg_catalog.count(*) from vortex_event.event_outbox
   where record_id = :'refused_parent_record'::uuid),
  0::bigint,
  'a refused parent deletion appends no Event'
);

-- ---------------------------------------------------------------------------
-- 3. A caller without current authority over an affected record is refused,
--    and the refusal describes nothing about that record.
-- ---------------------------------------------------------------------------

select pg_temp.delete_context(:'app'::uuid, :'scoped_account'::uuid);
set local role vortex_runtime;
select vortex_record.prepare_protected_parent_delete(
  :'command_scoped'::uuid, :'parent_type'::uuid, :'deletable_parent_record'::uuid,
  1, :'activity_scoped'::uuid)::text as scoped_result \gset
reset role;

select is(
  (:'scoped_result'::jsonb) ->> 'outcome', 'refused',
  'a caller without authority on every affected record is refused'
);
select is(
  (:'scoped_result'::jsonb) ->> 'reasonCode', 'record_unavailable',
  'the authority refusal uses the existing non-disclosing reason'
);
select ok(
  (:'scoped_result'::jsonb)::text not like ('%' || :'line_record' || '%')
  and (:'scoped_result'::jsonb)::text not like ('%' || :'subline_record' || '%'),
  'the authority refusal never identifies the affected record that blocked it'
);
select is(
  (select pg_catalog.count(*) from vortex_record.delete_command_receipts),
  0::bigint,
  'an authority refusal leaves no command receipt behind'
);
select is(
  (select pg_catalog.count(*) from vortex_record.delete_command_effects),
  0::bigint,
  'an authority refusal leaves no journal effect behind'
);
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number) order by stored.record_id)
   from record_data.rt_b4950000000040008000000000000005 as stored),
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'lifecycleState', 'active', 'concurrencyNumber', 1)),
  'an authority refusal leaves the affected dependent untouched'
);

-- ---------------------------------------------------------------------------
-- 4. A prepared but unfinalized command cannot reach commit.
-- ---------------------------------------------------------------------------

select pg_temp.delete_context(:'app'::uuid, :'full_account'::uuid);
savepoint pending_commit_probe;
set local role vortex_runtime;
select vortex_record.prepare_protected_parent_delete(
  :'command_pending'::uuid, :'parent_type'::uuid, :'deletable_parent_record'::uuid,
  1, :'activity_pending'::uuid)::text as pending_result \gset
reset role;
select is(
  (:'pending_result'::jsonb) ->> 'outcome', 'prepared',
  'the mutating preparation reports a prepared closure'
);
select is(
  (select state from vortex_record.delete_command_receipts
   where command_id = :'command_pending'::uuid),
  'pending',
  'the preparation holds exactly one pending scoped receipt'
);

-- While this command really does hold a pending journal, the adapter-private
-- overload is offered a deleted-record set that the journal did not produce.
-- It re-derives the set and refuses, so the ninth argument can never widen,
-- narrow or redirect the affected record set.
set local role vortex_record_adapter;
select vortex_record.prepare_relationship_total_save(
  :'command_pending'::uuid, 'delete', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 1, '{}'::jsonb, null, :'activity_pending'::uuid,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId', :'category_type', 'recordId', :'category_record',
    'storageContractId', :'category_storage',
    'preConcurrencyNumber', 2, 'postConcurrencyNumber', 3)))::text as mismatched \gset
-- An empty set is equally a mismatch against a journal that holds three
-- soft-deleted records.
select vortex_record.prepare_relationship_total_save(
  :'command_pending'::uuid, 'delete', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 1, '{}'::jsonb, null, :'activity_pending'::uuid,
  '[]'::jsonb)::text as emptied \gset
-- The same pending journal, supplied faithfully, still prepares.
select vortex_record.prepare_relationship_total_save(
  :'command_pending'::uuid, 'delete', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 1, '{}'::jsonb, null, :'activity_pending'::uuid,
  vortex_record.delete_command_deleted_records_internal(
    :'command_pending'::uuid))::text as journalled \gset
-- The root revision must be the one the traversal journalled.
select vortex_record.prepare_relationship_total_save(
  :'command_pending'::uuid, 'delete', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 7, '{}'::jsonb, null, :'activity_pending'::uuid,
  vortex_record.delete_command_deleted_records_internal(
    :'command_pending'::uuid))::text as stale_revision \gset
reset role;

select is(
  (:'mismatched'::jsonb) ->> 'reasonCode', 'record_unavailable',
  'a deleted-record set the scoped journal did not produce is refused'
);
select is(
  (:'emptied'::jsonb) ->> 'reasonCode', 'record_unavailable',
  'an emptied deleted-record set is refused against the same pending journal'
);
select is(
  (:'journalled'::jsonb) ->> 'outcome', 'prepared',
  'the same pending journal, supplied faithfully, prepares the closure'
);
select is(
  (:'stale_revision'::jsonb) ->> 'outcome', 'conflict',
  'the delete-mode preparation keeps the canonical root revision check'
);

select throws_ok(
  'set constraints vortex_record.delete_command_receipts_completed_at_commit immediate',
  '23514',
  'Protected parent delete preparation was not finalized',
  'a prepared but unfinalized delete command cannot reach commit'
);
rollback to savepoint pending_commit_probe;
select is(
  (select pg_catalog.count(*) from vortex_record.delete_command_receipts),
  0::bigint,
  'rolling back the unfinalized preparation leaves no receipt'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number)
   from record_data.rt_b4950000000040008000000000000001 as stored
   where stored.record_id = :'deletable_parent_record'::uuid),
  pg_catalog.jsonb_build_object('lifecycleState', 'active', 'concurrencyNumber', 1),
  'rolling back the unfinalized preparation restores the parent exactly'
);

-- ---------------------------------------------------------------------------
-- 5. The cascade, the cleared optional link, and the journal-derived closure.
-- ---------------------------------------------------------------------------

set local role vortex_runtime;
select vortex_record.prepare_protected_parent_delete(
  :'command_delete'::uuid, :'parent_type'::uuid, :'deletable_parent_record'::uuid,
  1, :'activity_delete'::uuid)::text as prepared \gset
reset role;

select is(
  (:'prepared'::jsonb) ->> 'outcome', 'prepared',
  'the protected parent deletion prepares its surviving affected closure'
);
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'kind', effect.effect_kind, 'recordTypeId', effect.record_type_id)
     order by effect.effect_sequence)
   from vortex_record.delete_command_effects as effect
   where effect.command_id = :'command_delete'::uuid),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('kind', 'optional_cleared', 'recordTypeId', :'note_type'),
    pg_catalog.jsonb_build_object('kind', 'soft_deleted', 'recordTypeId', :'subline_type'),
    pg_catalog.jsonb_build_object('kind', 'soft_deleted', 'recordTypeId', :'line_type'),
    pg_catalog.jsonb_build_object('kind', 'soft_deleted', 'recordTypeId', :'parent_type')),
  'the one traversal journals the cleared child, the nested dependant, the dependent and the named parent in its own deterministic order'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number,
     'removalDueAt', stored.removal_due_at,
     'deletedSet', stored.deleted_at is not null)
   from record_data.rt_b4950000000040008000000000000005 as stored
   where stored.record_id = :'line_record'::uuid),
  pg_catalog.jsonb_build_object('lifecycleState', 'soft_deleted',
    'concurrencyNumber', 2, 'removalDueAt', null, 'deletedSet', true),
  'a declared dependent with inherited ownership through that relationship is recoverably soft deleted'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number,
     'removalDueAt', stored.removal_due_at,
     'deletedSet', stored.deleted_at is not null)
   from record_data.rt_b4950000000040008000000000000006 as stored
   where stored.record_id = :'subline_record'::uuid),
  pg_catalog.jsonb_build_object('lifecycleState', 'soft_deleted',
    'concurrencyNumber', 2, 'removalDueAt', null, 'deletedSet', true),
  'the nested dependant is recoverably soft deleted with its own parent'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number,
     'parentLink', stored.f_f4950000000040008000000000000022)
   from record_data.rt_b4950000000040008000000000000003 as stored
   where stored.record_id = :'note_record'::uuid),
  pg_catalog.jsonb_build_object('lifecycleState', 'active',
    'concurrencyNumber', 2, 'parentLink', null),
  'the optional link is cleared on the surviving child and the child stays active'
);
select is(
  (select pg_catalog.count(*) from vortex_record.relationship_edges
   where relationship_id = :'rel_note_parent'::uuid
     and from_record_id = :'note_record'::uuid),
  0::bigint,
  'the cleared optional link leaves the surviving child row and its edge consistent'
);
select is(
  (select pg_catalog.jsonb_agg(item.value ->> 'recordKey' order by item.value ->> 'recordKey')
   from pg_catalog.jsonb_array_elements((:'prepared'::jsonb) -> 'records') as item(value)),
  pg_catalog.jsonb_build_array(
    pg_catalog.lower(:'category_type') || ':' || pg_catalog.lower(:'category_record'),
    pg_catalog.lower(:'note_type') || ':' || pg_catalog.lower(:'note_record'),
    'root'),
  'the prepared closure is exactly the deleted root plus every surviving affected record'
);
select ok(
  not exists (
    select 1 from pg_catalog.jsonb_array_elements((:'prepared'::jsonb) -> 'records') as item(value)
    where item.value ->> 'recordId' in (:'line_record', :'subline_record', :'deletable_parent_record')
  ),
  'no record this command deleted is prepared as a surviving affected record'
);
-- The deleted root is carried with the trusted pre-delete values the traversal
-- journalled, not an empty object, so the delivered evaluator sees a complete
-- record and cannot reject the command over the root's own required fields.
select is(
  (select item.value -> 'existingValues'
   from pg_catalog.jsonb_array_elements((:'prepared'::jsonb) -> 'records') as item(value)
   where item.value ->> 'recordKey' = 'root'),
  pg_catalog.jsonb_build_object(:'f_parent_title', 'Deletable parent'),
  'the closure root carries the journalled pre-delete values of the named parent'
);
select is(
  (select pg_catalog.jsonb_agg(item.value -> 'preConcurrencyNumber'
     order by item.value ->> 'recordTypeId')
   from pg_catalog.jsonb_array_elements((:'prepared'::jsonb) -> 'deletedRecordKeys') as item(value)),
  pg_catalog.jsonb_build_array(1, 1, 1),
  'the preparation reports the journalled pre-delete revision of every deleted record'
);
select is(
  (select pg_catalog.jsonb_agg(source.value -> 'records' order by source.value ->> 'relationshipId')
   from pg_catalog.jsonb_array_elements((:'prepared'::jsonb) -> 'records') as item(value)
   cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'relationshipSources') as source(value)
   where item.value ->> 'recordId' = :'category_record'),
  pg_catalog.jsonb_build_array('[]'::jsonb, '[]'::jsonb),
  'the surviving parent aggregates over no remaining member, because both contributors were deleted by this command'
);

-- ---------------------------------------------------------------------------
-- 6. The terminal writer accepts only the exact prepared shape, then leaves
--    every surviving parent authoritative.
-- ---------------------------------------------------------------------------

select pg_catalog.jsonb_agg(
  pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId',
    'recordId', item.value -> 'recordId',
    'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
    'finalValues', case when item.value ->> 'recordId' = :'category_record'
      then pg_catalog.jsonb_build_object(
        :'f_category_line_total', '0.00',
        :'f_category_display', '0.00',
        :'f_category_subline_total', '0.00')
      else '{}'::jsonb end)
  order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
)::text as parent_mutations
from pg_catalog.jsonb_array_elements((:'prepared'::jsonb) -> 'records') as item(value)
where item.value ->> 'recordKey' <> 'root' \gset

-- The writer accepts exactly the prepared shape. An entry that carries every
-- required key but also an extra one is not that shape and is refused, rather
-- than being silently accepted with the extra key ignored.
select pg_catalog.jsonb_agg(
  case when item.value ->> 'recordId' = :'category_record'
    then item.value || pg_catalog.jsonb_build_object('ownerOrganizationAccountId', :'full_account')
    else item.value end
)::text as padded_mutations
from pg_catalog.jsonb_array_elements(:'parent_mutations'::jsonb) as item(value) \gset

select throws_ok(
  format($probe$
    set local role vortex_runtime;
    select vortex_record.finalize_protected_parent_delete(
      %L::uuid, %L::uuid, %L::uuid, 1, %L::uuid, %L::uuid, %L::jsonb)
  $probe$, :'command_delete', :'parent_type', :'deletable_parent_record',
     :'activity_delete', :'occurrence_delete', :'padded_mutations'),
  '42501',
  'Protected parent delete parent mutation is invalid',
  'a parent mutation carrying any key beyond the prepared four is refused'
);
reset role;

set local role vortex_runtime;
select vortex_record.finalize_protected_parent_delete(
  :'command_delete'::uuid, :'parent_type'::uuid, :'deletable_parent_record'::uuid,
  1, :'activity_delete'::uuid, :'occurrence_delete'::uuid,
  :'parent_mutations'::jsonb)::text as finalized \gset
reset role;

select is(
  pg_catalog.jsonb_build_object(
    'outcome', (:'finalized'::jsonb) -> 'outcome',
    'recordId', (:'finalized'::jsonb) -> 'recordId',
    'concurrencyNumber', (:'finalized'::jsonb) -> 'concurrencyNumber',
    'replayed', (:'finalized'::jsonb) -> 'replayed'),
  pg_catalog.jsonb_build_object(
    'outcome', pg_catalog.to_jsonb('completed'::text),
    'recordId', pg_catalog.to_jsonb(:'deletable_parent_record'::uuid),
    'concurrencyNumber', pg_catalog.to_jsonb(2),
    'replayed', pg_catalog.to_jsonb(false)),
  'the terminal writer completes the protected parent deletion'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'concurrencyNumber', stored.concurrency_number,
     'lineTotal', stored.f_f4950000000040008000000000000032,
     'display', stored.f_f4950000000040008000000000000033,
     'sublineTotal', stored.f_f4950000000040008000000000000034)
   from record_data.rt_b4950000000040008000000000000004 as stored
   where stored.record_id = :'category_record'::uuid),
  pg_catalog.jsonb_build_object(
    'concurrencyNumber', 3, 'lineTotal', '0.00', 'display', '0.00', 'sublineTotal', '0.00'),
  'the surviving parent of every soft-deleted record keeps an authoritative total and calculation'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'action', entry.action, 'outcome', entry.outcome, 'subjects', entry.subject_ids,
     'changedFields', entry.changed_field_ids)
   from vortex_activity.organization_activity_entries as entry
   where entry.activity_id = :'activity_delete'::uuid),
  pg_catalog.jsonb_build_object(
    'action', 'delete_record', 'outcome', 'completed',
    'subjects', pg_catalog.to_jsonb(array[:'deletable_parent_record'::uuid]),
    'changedFields', pg_catalog.to_jsonb(array[]::uuid[])),
  'the completed deletion appends exactly one delete Activity for the named parent'
);
select is(
  (select pg_catalog.count(*) from vortex_event.event_outbox as occurrence
   where occurrence.record_id = :'deletable_parent_record'::uuid),
  1::bigint,
  'the completed deletion appends exactly one Event occurrence for the named parent'
);
select is(
  (select state from vortex_record.delete_command_receipts
   where command_id = :'command_delete'::uuid),
  'completed',
  'the command receipt is completed inside the same transaction'
);
select is(
  (select pg_catalog.jsonb_build_object(
     'lifecycleState', stored.lifecycle_state,
     'concurrencyNumber', stored.concurrency_number)
   from record_data.rt_b4950000000040008000000000000003 as stored
   where stored.record_id = :'note_record'::uuid),
  pg_catalog.jsonb_build_object('lifecycleState', 'active', 'concurrencyNumber', 2),
  'a surviving affected record with no generated value is not revised a second time'
);

-- ---------------------------------------------------------------------------
-- 7. Duplicate command refusal, preserved the way the save path preserves it.
-- ---------------------------------------------------------------------------

set local role vortex_runtime;
select vortex_record.prepare_protected_parent_delete(
  :'command_delete'::uuid, :'parent_type'::uuid, :'deletable_parent_record'::uuid,
  1, :'activity_delete'::uuid)::text as replayed \gset
select vortex_record.prepare_protected_parent_delete(
  :'command_delete'::uuid, :'parent_type'::uuid, :'deletable_parent_record'::uuid,
  2, :'activity_delete'::uuid)::text as changed_input \gset
reset role;

select is(
  pg_catalog.jsonb_build_object(
    'outcome', (:'replayed'::jsonb) -> 'outcome',
    'recordId', (:'replayed'::jsonb) -> 'recordId',
    'concurrencyNumber', (:'replayed'::jsonb) -> 'concurrencyNumber',
    'replayed', (:'replayed'::jsonb) -> 'replayed'),
  pg_catalog.jsonb_build_object(
    'outcome', pg_catalog.to_jsonb('completed'::text),
    'recordId', pg_catalog.to_jsonb(:'deletable_parent_record'::uuid),
    'concurrencyNumber', pg_catalog.to_jsonb(2),
    'replayed', pg_catalog.to_jsonb(true)),
  'an exact duplicate command replays its own completed outcome and repeats no effect'
);
select is(
  (:'changed_input'::jsonb) ->> 'reasonCode', 'command_identity_conflict',
  'a changed-input duplicate is refused exactly as the save path refuses it'
);
select is(
  (select pg_catalog.count(*) from vortex_record.delete_command_effects
   where command_id = :'command_delete'::uuid),
  4::bigint,
  'replaying the command journals no further effect'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
   where activity_id = :'activity_delete'::uuid),
  1::bigint,
  'replaying the command appends no further Activity'
);

-- ---------------------------------------------------------------------------
-- 8. No caller can supply a deleted identity: the private delete-mode
--    preparation is rooted only in a scoped pending journal.
-- ---------------------------------------------------------------------------

set local role vortex_record_adapter;
-- No pending journal at all.
select vortex_record.prepare_relationship_total_save(
  :'command_unknown'::uuid, 'delete', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 1, '{}'::jsonb, null, :'activity_delete'::uuid,
  '[]'::jsonb)::text as unjournalled \gset
-- A completed receipt is no longer a pending journal.
select vortex_record.prepare_relationship_total_save(
  :'command_delete'::uuid, 'delete', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 1, '{}'::jsonb, null, :'activity_delete'::uuid,
  '[]'::jsonb)::text as completed_journal \gset
-- The overload serves no other operation.
select vortex_record.prepare_relationship_total_save(
  :'command_delete'::uuid, 'update', :'parent_type'::uuid,
  :'deletable_parent_record'::uuid, 1, '{}'::jsonb, null, :'activity_delete'::uuid,
  '[]'::jsonb)::text as wrong_operation \gset
reset role;

select is(
  (:'unjournalled'::jsonb) ->> 'reasonCode', 'record_unavailable',
  'the delete-mode preparation refuses a command that holds no pending journal'
);
select is(
  (:'completed_journal'::jsonb) ->> 'reasonCode', 'record_unavailable',
  'the delete-mode preparation refuses a command whose receipt is already completed'
);
select is(
  (:'wrong_operation'::jsonb) ->> 'reasonCode', 'command_invalid',
  'the deleted-record input is fenced to the delete operation'
);

select * from finish();
rollback;
