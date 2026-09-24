-- #569: one action may create records *and* change the subject's own links.
--
-- `20260921100000_named_action_create_record.sql` deliberately refused that one
-- combination (`create_with_subject_link_unsupported`). The refusal existed for
-- a real reason: `save_named_action_set_fields_internal` writes the subject's
-- relationship edge inside the same call that claims the command receipt, so a
-- create-bearing command took the subject's relationship edge identity (L6)
-- before any created record allocated a reference-number counter (L4).
-- Ordinary create allocates every counter before its relationship loop, so the
-- named path held `A(relS, X)` while waiting for `C(storage(S), refField)`,
-- and a concurrent ordinary create of `S` linked to `X` held that counter while
-- waiting for `A(relS, X)`: a hard cycle.
--
-- This migration lifts the refusal by removing the cycle. Before the subject
-- writer runs, `reserve_named_action_creation_reference_numbers_internal`
-- takes every created record's reference-number counter (L4) in one canonical
-- order. The subject writer's edges (L5/L6) then follow, and the later
-- `insert_named_action_record_internal` re-takes its counters for free. That is
-- the counter-before-edge order ordinary create uses, so the combination is
-- safe rather than merely unhidden.
--
-- Both functions are patched in place from their current live definitions, as
-- `20260923220000` and `20260923230000` do: each reviewed fragment must occur
-- exactly once, or the migration aborts instead of silently skipping a caller.
-- Grants, ownership and authorization are otherwise unchanged.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- ---------------------------------------------------------------------------
-- Reference-number reservation. Locks (and, when absent, creates) each created
-- record's reference-number counter rows before the subject writer writes any
-- relationship edge, matching the counter-before-edge order of ordinary
-- create. The row is created at `startingNumber`, exactly the state a counter
-- is in before its first allocation, so a reservation that is later abandoned
-- by a committed refusal consumes no number. `allocate_reference_number_internal`
-- then increments the same, already held, row and returns the first number
-- unchanged.
-- ---------------------------------------------------------------------------
create function vortex_record.reserve_named_action_creation_reference_numbers_internal(
  p_creations jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  counters jsonb := '[]'::jsonb;
  creation jsonb;
  creation_meta jsonb;
  record_type_value jsonb;
  storage_contract_id_value uuid;
  storage_scope_value text;
  field_item jsonb;
  field_settings jsonb;
  counter_row record;
begin
  if pg_catalog.jsonb_typeof(p_creations) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Named action creation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    creation_meta := vortex_record.resolve_record_action_context_internal(
      (creation ->> 'recordTypeId')::uuid, 'create'
    );
    if pg_catalog.jsonb_typeof(creation_meta -> 'recordType') <> 'object' then
      raise exception using errcode = '55000',
        message = 'Named action creation target is unavailable';
    end if;
    record_type_value := creation_meta -> 'recordType';
    storage_contract_id_value := (creation_meta ->> 'storageContractId')::uuid;
    storage_scope_value := creation_meta ->> 'storageScope';
    for field_item in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      if field_item ->> 'type' <> 'reference_number' then continue; end if;
      field_settings := coalesce(field_item -> 'settings', '{}'::jsonb);
      -- A malformed setting is left for `allocate_reference_number_internal` to
      -- reject; this pass only reserves a valid counter.
      if pg_catalog.jsonb_typeof(field_settings -> 'digits') <> 'number'
        or (field_settings ->> 'digits')::integer not between 1 and 20
        or (field_settings ? 'startingNumber' and (
          pg_catalog.jsonb_typeof(field_settings -> 'startingNumber') <> 'number'
          or (field_settings ->> 'startingNumber')::numeric < 1
          or pg_catalog.trunc((field_settings ->> 'startingNumber')::numeric)
            <> (field_settings ->> 'startingNumber')::numeric
        )) then
        continue;
      end if;
      counters := counters || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', storage_contract_id_value,
        'fieldId', (field_item ->> 'fieldId')::uuid,
        'applicationRootId', case when storage_scope_value = 'application_contained'
          then application_root_id_value else null end,
        'startNumber', coalesce((field_settings ->> 'startingNumber')::numeric, 1)
      ));
    end loop;
  end loop;

  for counter_row in
    select distinct
      (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      (item.value ->> 'fieldId')::uuid as field_id,
      nullif(item.value ->> 'applicationRootId', '')::uuid as application_root_id,
      (item.value ->> 'startNumber')::numeric as start_number
    from pg_catalog.jsonb_array_elements(counters) as item(value)
    order by 1, 2, 3
  loop
    insert into vortex_record.record_reference_counters (
      organization_id, storage_contract_id, field_id, application_root_id, next_number
    ) values (
      organization_id_value, counter_row.storage_contract_id, counter_row.field_id,
      counter_row.application_root_id, counter_row.start_number
    )
    on conflict (organization_id, storage_contract_id, field_id, application_root_id)
      do update set next_number = vortex_record.record_reference_counters.next_number;
  end loop;
end
$function$;

-- Migration-time patch guard: returns the current definition with every
-- `[old, new]` pair substituted, each old fragment occurring exactly once.
create function vortex_record.apply_named_action_create_patch_internal(
  p_procedure pg_catalog.regprocedure,
  p_patches jsonb
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  definition text;
  patch jsonb;
  old_text text;
  occurrences integer;
begin
  definition := pg_catalog.pg_get_functiondef(p_procedure);
  if definition is not null then
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
  end if;
  if definition is null or pg_catalog.jsonb_typeof(p_patches) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_patches) = 0 then
    raise exception using errcode = '22023',
      message = 'Named action create patch is invalid';
  end if;
  for patch in select item.value from pg_catalog.jsonb_array_elements(p_patches) as item(value)
  loop
    old_text := patch ->> 0;
    if old_text is null or old_text = '' or patch ->> 1 is null then
      raise exception using errcode = '22023',
        message = 'Named action create patch is invalid';
    end if;
    occurrences := (
      pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
    ) / pg_catalog.length(old_text);
    if occurrences <> 1 then
      raise exception using errcode = '55000',
        message = 'Named action create patch does not match exactly once',
        detail = p_procedure::text;
    end if;
    definition := pg_catalog.replace(definition, old_text, patch ->> 1);
  end loop;
  return definition;
end
$function$;

do $migration$
declare
  -- The refusal the slice shipped, removed because the counter/edge cycle it
  -- guarded against is now closed by the reservation step below.
  refusal_old constant text := $q$  -- Refusal 5, and the one place this slice narrows what an action may
  -- express. `save_named_action_set_fields_internal:591` writes the subject's
  -- own relationship edge inside the same call that claims the command
  -- receipt, so it necessarily takes the relationship advisory key (L6) before
  -- any creation can allocate a reference-number counter (L4). Ordinary create
  -- takes those in the opposite order (`20260913030000:787-806` before
  -- `:868-877`), which is a hard cycle: this command would hold
  -- `A(relS, X)` and wait for `C(storage(S), refField)` while a concurrent
  -- ordinary create of `S` linked to `X` holds that counter and waits for
  -- `A(relS, X)`. Lifting this needs an explicit named-action subject writer
  -- that allocates the creations' reference numbers between claiming the
  -- receipt and writing the subject's edges; that is deliberately not done
  -- here rather than hidden.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'create_record'
  ) and exists (
    select 1
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects') effect(value)
    join pg_catalog.jsonb_array_elements(
      action_context -> 'recordType' -> 'fields'
    ) field(value)
      on pg_catalog.lower(field.value ->> 'fieldId') =
        pg_catalog.lower(effect.value ->> 'fieldId')
    where effect.value ->> 'kind' = 'set_field'
      and field.value ->> 'type' in ('link', 'link_to_one_of_several')
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', 'create_with_subject_link_unsupported'
    );
  end if;
$q$;
  refusal_new constant text := $q$  -- #569: a create-bearing command may also change the subject's own links.
  -- The cycle this used to guard against (subject relationship edge L6 before a
  -- created record's reference-number counter L4) is closed by reserving every
  -- creation's counter before the subject writer runs.
$q$;

  -- The terminal writer: reserve the creations' reference-number counters
  -- after the merged preparation and before the subject writer writes any
  -- relationship edge, so counters (L4) precede edges (L5/L6) exactly as they
  -- do for ordinary create. `create_targets` is only non-null on the fresh,
  -- non-replay path, so a replay keeps its original short-circuit and consumes
  -- nothing.
  reserve_old constant text := $q$  result_value := vortex_record.save_named_action_set_announce($q$;
  reserve_new constant text := $q$  -- #569: take every created record's reference-number counter (L4) before the
  -- subject writer writes the subject's relationship edges (L5/L6), matching
  -- ordinary create's counter-before-edge order.
  if creation_count > 0 and create_targets is not null then
    perform vortex_record.reserve_named_action_creation_reference_numbers_internal(
      p_creations
    );
  end if;
  result_value := vortex_record.save_named_action_set_announce($q$;

  target record;
  definition text;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.patches
    from (values
      ('vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(refusal_old, refusal_new))),
      ('vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(reserve_old, reserve_new)))
    ) as candidate(procedure_id, patches)
  loop
    -- Patched as this migration's adapter role, then re-created under the
    -- function's own current owner so its grants, comment and OID stay put.
    definition := vortex_record.apply_named_action_create_patch_internal(
      target.procedure_id, target.patches
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
drop function vortex_record.apply_named_action_create_patch_internal(
  pg_catalog.regprocedure, jsonb
);

alter function vortex_record.reserve_named_action_creation_reference_numbers_internal(jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.reserve_named_action_creation_reference_numbers_internal(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.reserve_named_action_creation_reference_numbers_internal(jsonb)
to vortex_record_adapter;

comment on function vortex_record.reserve_named_action_creation_reference_numbers_internal(jsonb) is
  'Private named-action step: takes every created record''s reference-number counter (L4) before the subject writer writes any relationship edge (L5/L6), so a combined create and subject-link command locks counters ahead of edges as ordinary create does.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
