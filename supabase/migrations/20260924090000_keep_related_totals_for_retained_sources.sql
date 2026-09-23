-- #837: keep a related total visible when a contributing child is soft-deleted.
--
-- The protected delete path already skips a retained (soft-deleted) source:
-- 20260923180000 extends each total preflight with
-- `relationship_total_source_is_retained_internal`, so a retained source that
-- the active-row snapshot cannot see is dropped from the total instead of
-- failing it. The read projection had no matching lifecycle filter.
-- `total_inputs_readable_internal` walks every relationship edge of the
-- already-authorized target, reads each contributing source through the
-- adapter's access decision, and removes the total from the readable fields
-- when any source is refused. A soft-deleted child keeps its edge, the access
-- evaluator refuses a non-active record, the helper returns false and the total
-- disappears for every viewer.
--
-- `total_inputs_readable_internal` is created only in
-- `20260913123000_protect_related_total_projection.sql` and no later migration
-- rewrites it, so it is patched in place from its current definition exactly as
-- `20260924001000_return_target_record_field_values.sql` does: the reviewed
-- source fragment must occur exactly once, or the migration aborts rather than
-- silently skipping. It is re-created under its own current owner, so its OID,
-- grants, security and search_path stay put.
--
-- The skip applies the same retained-source helper the delete path uses, with
-- the same catalogue, source record type, edge source and target scope facts
-- the projection already holds. Totals are not calculated differently: a
-- retained source is excluded exactly as the delete preflight excludes it, and
-- a refused active source still fails the total.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

do $migration$
declare
  fragment_old constant text := $q$    if source_projection is null then
      return false;
    end if;
$q$;
  fragment_new constant text := $q$    if source_projection is null then
      if vortex_record.relationship_total_source_is_retained_internal(
        p_loaded -> 'facts',
        (contract_value ->> 'sourceRecordTypeId')::uuid,
        edge_row.from_record_id,
        (p_loaded -> 'context' ->> 'organizationId')::uuid,
        (p_loaded -> 'context' ->> 'applicationRootId')::uuid
      ) then
        continue;
      end if;
      return false;
    end if;
$q$;

  procedure_id constant pg_catalog.regprocedure :=
    'vortex_record.total_inputs_readable_internal(jsonb,uuid,uuid,jsonb,jsonb)'::pg_catalog.regprocedure;
  definition text;
  occurrences integer;
  owner_name name;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  if definition is null then
    raise exception using errcode = '55000',
      message = 'Related-total input reader is unavailable',
      detail = procedure_id::text;
  end if;
  occurrences := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, fragment_old, ''))
  ) / pg_catalog.length(fragment_old);
  if occurrences <> 1 then
    raise exception using errcode = '55000',
      message = 'Related-total retained-source patch does not match exactly once',
      detail = procedure_id::text;
  end if;
  definition := pg_catalog.replace(definition, fragment_old, fragment_new);

  -- Re-created under the function's own current owner so its grants,
  -- comment and OID stay put.
  select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
  from pg_catalog.pg_proc as procedure
  where procedure.oid = procedure_id;
  execute pg_catalog.format('set local role %I', owner_name);
  execute definition;
  set local role vortex_record_adapter;
end
$migration$;

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
