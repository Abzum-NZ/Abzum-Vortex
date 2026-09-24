-- #858: in a multi-relationship save, take every target row lock before any
-- relationship edge identity.
--
-- `20260923220000` made relationship edge identities the last lock class: after
-- its caller has locked the source row, one writer takes the new target row's
-- share lock and the source data-version bump before the sorted edge
-- identities, so an identity is never requested ahead of the participant row it
-- belongs to. That order holds inside one `write_relationship_value_internal`
-- call, but not across the save loops that call it once per changed
-- relationship: iteration k+1 share-locks a new target row after iteration k
-- already holds its edge identities. Two saves can then wait on each other -- a
-- target row one transaction holds exclusively against an edge identity the
-- other already holds -- which PostgreSQL reports as 40P01.
--
-- This migration gives the loops the same order the named-action creation path
-- already uses (`20260921100000:24-35`: row, counter, link-target share lock,
-- edge identity): every target row lock is taken before the first edge
-- identity. `lock_relationship_target_row_internal` is the one target
-- share-lock contract, identical to the lock the writer already takes. The two
-- update loops call it for every changed non-null link once that target has
-- passed the same access decision the writer re-checks, before `change_record`
-- or the first writer bumps the source data version. `create_record_internal`
-- calls it for every created link after its counters and insert and before the
-- new record's data-version bump, which `20260923220000` moved ahead of the
-- edge pass. A target share lock therefore never waits behind a data version or
-- edge identity the same transaction already holds: without that, creating a
-- record linked to a record of its own type could hold the type's data version
-- while waiting for the parent row that a concurrent update of that parent holds
-- exclusively before bumping the same data version.
--
-- Relationship semantics, identity keys, `acquire_relationship_edge_locks_internal`
-- and the writer are unchanged. The three loop bodies are patched in place from
-- their current `pg_get_functiondef`, matching the reviewed source text exactly
-- once so drift fails the migration instead of silently skipping a caller, and
-- recreated under their own current owner.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- One target row share lock for the current request organisation. This is the
-- same lock `write_relationship_value_internal` takes inline: the target row
-- must be active in the caller's organisation, and the lock is held until the
-- transaction ends. It is split out so every multi-relationship loop can take
-- all of its target row locks before it takes any edge identity.
create function vortex_record.lock_relationship_target_row_internal(
  p_target_record_type_id uuid,
  p_target_record_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  target_meta jsonb;
  target_locked boolean;
begin
  if p_target_record_type_id is null or p_target_record_id is null
    or p_organization_id is null
    or p_target_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Relationship target is invalid';
  end if;
  target_meta := vortex_record.resolve_record_action_context_internal(
    p_target_record_type_id, 'read'
  );
  if pg_catalog.jsonb_typeof(target_meta -> 'table') is distinct from 'string' then
    raise exception using errcode = 'P0002',
      message = 'Relationship target is unavailable';
  end if;
  target_locked := false;
  execute pg_catalog.format(
    'select true from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active'' for share',
    target_meta ->> 'table'
  ) into target_locked using p_organization_id, p_target_record_id;
  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002',
      message = 'Relationship target is unavailable';
  end if;
end
$function$;

-- Assert that the reviewed source text is still exactly present once, then
-- substitute it. The migration aborts instead of silently skipping a caller.
create function vortex_record.apply_multi_target_lock_patch_internal(
  p_definition text,
  p_old text,
  p_new text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  occurrences integer;
  definition text;
begin
  if p_definition is null or p_old is null or p_new is null or p_old = '' then
    raise exception using errcode = '22023',
      message = 'Multi-target lock patch is invalid';
  end if;
  -- Stored bodies may carry CRLF depending on how the migration was checked
  -- out; match and return the LF form, as `20260924200000` does.
  definition := pg_catalog.replace(p_definition, E'\r\n', E'\n');
  occurrences := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, p_old, ''))
  ) / pg_catalog.length(p_old);
  if occurrences <> 1 then
    raise exception using errcode = '55000',
      message = 'Multi-target lock patch does not match exactly once';
  end if;
  return pg_catalog.replace(definition, p_old, p_new);
end
$function$;

do $migration$
declare
  definition text;

  -- save_base_record / save_named_action_set_fields_internal proposed-facts
  -- loop: after a changed link's target has passed the same access decision the
  -- writer re-checks, lock its row before the loop reaches the writer.
  update_lock_old constant text := $q$        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');$q$;
  update_lock_new constant text := $q$        -- #858: take this target row lock here, before the writer loop below
        -- takes any edge identity, so a later iteration never locks a target
        -- row after an earlier iteration already holds an edge identity.
        perform vortex_record.lock_relationship_target_row_internal(
          target_record_type_id, target_record_id, organization_id_value
        );
        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');$q$;

  -- create_record_internal: after the counters and the insert, and before the
  -- new record's data-version bump and edge pass (`20260923220000`), lock every
  -- created link's target row in the same relationship order the edge pass uses.
  create_lock_old constant text := $q$    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    perform vortex_record.bump_record_data_version_internal($q$;
  create_lock_new constant text := $q$    -- #858: lock every created link's target row before the data-version bump
    -- and edge pass below, so a multi-link create takes all its row locks
    -- before its data version and any edge identity, as the update writer does.
    -- A malformed or undeclared link is left to the writer's own validation.
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if pg_catalog.jsonb_typeof(input_value) = 'object'
          and input_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
          and pg_catalog.jsonb_typeof(input_value -> 'recordTypeId') = 'string'
          and pg_catalog.jsonb_typeof(input_value -> 'recordId') = 'string'
          and pg_catalog.pg_input_is_valid(input_value ->> 'recordTypeId', 'uuid')
          and pg_catalog.pg_input_is_valid(input_value ->> 'recordId', 'uuid')
          and pg_catalog.lower(input_value ->> 'recordTypeId') <>
            '00000000-0000-0000-0000-000000000000'
          and pg_catalog.lower(input_value ->> 'recordId') <>
            '00000000-0000-0000-0000-000000000000'
          and vortex_record.relationship_declares_target_internal(
            relationship_value, (input_value ->> 'recordTypeId')::uuid
          ) then
          perform vortex_record.lock_relationship_target_row_internal(
            (input_value ->> 'recordTypeId')::uuid,
            (input_value ->> 'recordId')::uuid,
            (context_value ->> 'organizationId')::uuid
          );
        end if;
      end if;
    end loop;
    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    perform vortex_record.bump_record_data_version_internal($q$;

  target record;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.old_text, candidate.new_text
    from (values
      ('vortex_record.save_base_record(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid)'::pg_catalog.regprocedure,
        update_lock_old, update_lock_new),
      ('vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure,
        update_lock_old, update_lock_new),
      ('vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid)'::pg_catalog.regprocedure,
        create_lock_old, create_lock_new)
    ) as candidate(procedure_id, old_text, new_text)
  loop
    -- Patched as this migration's adapter role, then re-created under the
    -- function's own current owner so its grants, comment and OID stay put.
    definition := vortex_record.apply_multi_target_lock_patch_internal(
      pg_catalog.pg_get_functiondef(target.procedure_id),
      target.old_text, target.new_text
    );
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    set local role vortex_record_adapter;
  end loop;
end
$migration$;

-- Migration-time patch guard; it has no runtime role once the callers above
-- have been rewritten.
drop function vortex_record.apply_multi_target_lock_patch_internal(text, text, text);

revoke all on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
to vortex_record_adapter;

comment on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid) is
  'Share-locks one relationship target row in the request organisation and refuses an unavailable target; the multi-relationship loops take every target row lock through it before any edge identity.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
