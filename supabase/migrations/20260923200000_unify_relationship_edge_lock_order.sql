-- #561: one shared relationship identity and lock order for every current
-- relationship mutation path.
--
-- Every relationship write already takes a transaction-scoped advisory lock,
-- but `write_relationship_value_internal` and its named-action twin keyed it on
-- `relationship_id || ':' || target_record_id` only. That key cannot order two
-- mutations that share a source under the same relationship, and it leaves the
-- source participant entirely unkeyed, so a clear and a set on one source, or
-- two reciprocal moves (`X -> Y` while `Y -> X`), could only be separated by
-- row locks taken in an inconsistent order.
--
-- This migration defines one participant identity and one ordered acquisition
-- helper:
--
--   * `relationship_edge_record_identity_internal` — the permanent identity of
--     one participant of one edge: `relationship_id`, storage contract and
--     record id. Malformed or sentinel identities are refused, never inferred.
--   * `relationship_edge_lock_identities_internal` — the canonical, sorted set
--     of participant identities for one edge (source, and target when present).
--   * `acquire_relationship_edge_locks_internal` — acquires those identities as
--     transaction advisory locks in one deterministic `collate "C"` order.
--   * `acquire_incident_relationship_edge_locks_internal` — acquires the same
--     identities for every edge incident to a set of concrete records, so a
--     record-locking preflight takes the edge locks first.
--
-- The two edge writers, the recursive deletion traversal and all three current
-- relationship-total preflights are patched in place to call these helpers
-- before they take any participating row lock. The replacement guards fail the
-- migration if the current source text drifts, rather than silently skipping a
-- caller. Ownership, grants, `security definer`, transaction, revision and
-- authorization behavior are otherwise unchanged.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.relationship_edge_record_identity_internal(
  p_relationship_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_relationship_id is null or p_storage_contract_id is null or p_record_id is null
    or p_relationship_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Relationship edge participant identity is invalid';
  end if;
  return pg_catalog.concat_ws(
    ':',
    'vortex_record.relationship_edge',
    pg_catalog.lower(p_relationship_id::text),
    pg_catalog.lower(p_storage_contract_id::text),
    pg_catalog.lower(p_record_id::text)
  );
end
$function$;

create function vortex_record.relationship_edge_lock_identities_internal(
  p_relationship_id uuid,
  p_from_storage_contract_id uuid,
  p_from_record_id uuid,
  p_to_storage_contract_id uuid,
  p_to_record_id uuid
)
returns text[]
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  source_identity text;
  target_identity text;
begin
  if p_relationship_id is null
    or p_from_storage_contract_id is null or p_from_record_id is null then
    raise exception using errcode = '22023',
      message = 'Relationship edge identity is invalid';
  end if;
  if (p_to_storage_contract_id is null) <> (p_to_record_id is null) then
    raise exception using errcode = '22023',
      message = 'Relationship edge target identity is incomplete';
  end if;
  source_identity := vortex_record.relationship_edge_record_identity_internal(
    p_relationship_id, p_from_storage_contract_id, p_from_record_id
  );
  if p_to_storage_contract_id is null then
    return array[source_identity];
  end if;
  target_identity := vortex_record.relationship_edge_record_identity_internal(
    p_relationship_id, p_to_storage_contract_id, p_to_record_id
  );
  if source_identity = target_identity then
    return array[source_identity];
  end if;
  return case when source_identity collate "C" < target_identity collate "C"
    then array[source_identity, target_identity]
    else array[target_identity, source_identity] end;
end
$function$;

create function vortex_record.acquire_relationship_edge_locks_internal(
  p_identities text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if p_identities is null then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock set is invalid';
  end if;
  if pg_catalog.array_position(p_identities, null::text) is not null then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock identity is invalid';
  end if;
  if pg_catalog.cardinality(p_identities) = 0 then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(locked.identity, 0)
  )
  from (
    select distinct item.value collate "C" as identity
    from pg_catalog.unnest(p_identities) as item(value)
    order by identity collate "C"
  ) as locked;
end
$function$;

create function vortex_record.acquire_incident_relationship_edge_locks_internal(
  p_records jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  identities text[];
begin
  if p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock record set is invalid';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_records) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'object'
      or not (item.value ?& array['storageContractId', 'recordId'])
      or not pg_catalog.pg_input_is_valid(item.value ->> 'storageContractId', 'uuid')
      or not pg_catalog.pg_input_is_valid(item.value ->> 'recordId', 'uuid')
      or item.value ->> 'storageContractId' = '00000000-0000-0000-0000-000000000000'
      or item.value ->> 'recordId' = '00000000-0000-0000-0000-000000000000'
  ) then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock record identity is invalid';
  end if;
  with lock_records as (
    select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      (item.value ->> 'recordId')::uuid as record_id
    from pg_catalog.jsonb_array_elements(p_records) as item(value)
  )
  select coalesce(
    pg_catalog.array_agg(incident.identity order by incident.identity collate "C"),
    array[]::text[]
  )
  into identities
  from (
    select vortex_record.relationship_edge_record_identity_internal(
      edge.relationship_id, edge.from_storage_contract_id, edge.from_record_id
    ) as identity
    from vortex_record.relationship_edges as edge
    where exists (
      select 1 from lock_records as locked
      where (edge.from_storage_contract_id = locked.storage_contract_id
          and edge.from_record_id = locked.record_id)
        or (edge.to_storage_contract_id = locked.storage_contract_id
          and edge.to_record_id = locked.record_id)
    )
    union
    select vortex_record.relationship_edge_record_identity_internal(
      edge.relationship_id, edge.to_storage_contract_id, edge.to_record_id
    ) as identity
    from vortex_record.relationship_edges as edge
    where exists (
      select 1 from lock_records as locked
      where (edge.from_storage_contract_id = locked.storage_contract_id
          and edge.from_record_id = locked.record_id)
        or (edge.to_storage_contract_id = locked.storage_contract_id
          and edge.to_record_id = locked.record_id)
    )
  ) as incident;
  perform vortex_record.acquire_relationship_edge_locks_internal(identities);
end
$function$;

-- Assert that the reviewed source text is still exactly present once, then
-- substitute it. The migration aborts instead of silently skipping a caller.
create function vortex_record.apply_relationship_edge_lock_patch_internal(
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
begin
  if p_definition is null or p_old is null or p_new is null or p_old = '' then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock patch is invalid';
  end if;
  occurrences := (
    pg_catalog.length(p_definition)
    - pg_catalog.length(pg_catalog.replace(p_definition, p_old, ''))
  ) / pg_catalog.length(p_old);
  if occurrences <> 1 then
    raise exception using errcode = '55000',
      message = 'Relationship edge lock patch does not match exactly once';
  end if;
  return pg_catalog.replace(p_definition, p_old, p_new);
end
$function$;

do $migration$
declare
  definition text;
  procedure_id regprocedure;

  -- write_relationship_value_internal / write_named_action_relationship_value_internal
  edge_required_old constant text := $q$    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    delete from vortex_record.relationship_edges as edge$q$;
  edge_required_new constant text := $q$    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge$q$;

  edge_target_old constant text := $q$  target_locked := false;
  execute pg_catalog.format($q$;
  edge_target_new constant text := $q$  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  target_locked := false;
  execute pg_catalog.format($q$;

  edge_advisory_old constant text := $q$  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_record.relationship:' || p_relationship_id::text || ':' || target_record_id::text,
    0
  ));$q$;
  edge_advisory_new constant text := $q$  -- The shared relationship edge lock for this source and target is
  -- acquired above, before the target row lock, in the one canonical order.$q$;

  named_edge_advisory_old constant text := $q$  -- Same key literal as `write_relationship_value_internal:634-637`; the
  -- command preflight has already taken it in canonical order, and the lock is
  -- re-entrant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_record.relationship:' || p_relationship_id::text || ':' || target_record_id::text,
    0
  ));$q$;
  named_edge_advisory_new constant text := $q$  -- The shared relationship edge lock for this source and target is
  -- acquired above, before the target row lock, in the one canonical order; the
  -- command preflight has already taken the same participant identities.$q$;

  -- soft_delete_record_recursive_internal
  recursive_delete_old constant text := $q$  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';$q$;
  recursive_delete_new constant text := $q$  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  -- The shared edge locks for every edge incident to this record are taken
  -- first, before the record's own row lock and before any child row lock, so
  -- no relationship edge lock can be taken after a row lock this path holds.
  perform vortex_record.acquire_incident_relationship_edge_locks_internal(
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'storageContractId', meta ->> 'storageContractId', 'recordId', p_record_id
    ))
  );$q$;

  -- prepare_relationship_total_save
  total_save_old constant text := $q$  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in$q$;
  total_save_new constant text := $q$  perform vortex_record.acquire_incident_relationship_edge_locks_internal((
    select coalesce(pg_catalog.jsonb_agg(record_entry.value), '[]'::jsonb)
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as record_entry(value)
    where record_entry.value ? 'recordId'
  ));
  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in$q$;

  -- prepare_named_action_command_totals
  named_totals_old constant text := $q$  -- One canonical row pass over the union of closure records (`for update`) and$q$;
  named_totals_new constant text := $q$  perform vortex_record.acquire_incident_relationship_edge_locks_internal((
    select coalesce(pg_catalog.jsonb_agg(lock_record.value), '[]'::jsonb)
    from (
      select item.value
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
      where item.value ? 'recordId'
      union all
      select item.value
      from pg_catalog.jsonb_array_elements(link_targets) as item(value)
    ) as lock_record
  ));
  -- One canonical row pass over the union of closure records (`for update`) and$q$;

  -- prepare_record_lifecycle_totals_internal
  lifecycle_totals_old constant text := $q$  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'$q$;
  lifecycle_totals_new constant text := $q$  perform vortex_record.acquire_incident_relationship_edge_locks_internal((
    select coalesce(pg_catalog.jsonb_agg(record_entry.value), '[]'::jsonb)
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as record_entry(value)
    where record_entry.value ? 'recordId'
  ));
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'$q$;
begin
  procedure_id := 'vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean)'::pg_catalog.regprocedure;
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, edge_required_old, edge_required_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, edge_target_old, edge_target_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, edge_advisory_old, edge_advisory_new
  );
  execute definition;

  procedure_id := 'vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid)'::pg_catalog.regprocedure;
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, edge_required_old, edge_required_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, edge_target_old, edge_target_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, named_edge_advisory_old, named_edge_advisory_new
  );
  execute definition;

  procedure_id := 'vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[])'::pg_catalog.regprocedure;
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, recursive_delete_old, recursive_delete_new
  );
  execute definition;

  procedure_id := 'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::pg_catalog.regprocedure;
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, total_save_old, total_save_new
  );
  execute definition;

  procedure_id := 'vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid)'::pg_catalog.regprocedure;
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, named_totals_old, named_totals_new
  );
  execute definition;

  procedure_id := 'vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb)'::pg_catalog.regprocedure;
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, lifecycle_totals_old, lifecycle_totals_new
  );
  execute definition;
end
$migration$;

-- Migration-time patch guard; it has no runtime role once the callers above
-- have been rewritten.
drop function vortex_record.apply_relationship_edge_lock_patch_internal(text, text, text);

revoke all on function vortex_record.relationship_edge_record_identity_internal(uuid, uuid, uuid),
  vortex_record.relationship_edge_lock_identities_internal(uuid, uuid, uuid, uuid, uuid),
  vortex_record.acquire_relationship_edge_locks_internal(text[]),
  vortex_record.acquire_incident_relationship_edge_locks_internal(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.relationship_edge_record_identity_internal(uuid, uuid, uuid),
  vortex_record.relationship_edge_lock_identities_internal(uuid, uuid, uuid, uuid, uuid),
  vortex_record.acquire_relationship_edge_locks_internal(text[]),
  vortex_record.acquire_incident_relationship_edge_locks_internal(jsonb)
to vortex_record_adapter;

comment on function vortex_record.relationship_edge_record_identity_internal(uuid, uuid, uuid) is
  'Permanent identity of one participant of one relationship edge: relationship, storage contract and record. Malformed or sentinel identities raise.';
comment on function vortex_record.relationship_edge_lock_identities_internal(uuid, uuid, uuid, uuid, uuid) is
  'Canonical sorted participant identity set for one relationship edge: source always, target when present and exact.';
comment on function vortex_record.acquire_relationship_edge_locks_internal(text[]) is
  'Acquires transaction advisory locks for relationship edge participant identities in one deterministic collate "C" order.';
comment on function vortex_record.acquire_incident_relationship_edge_locks_internal(jsonb) is
  'Acquires the shared relationship edge participant locks for every edge incident to the supplied concrete records, before any participating row lock.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
