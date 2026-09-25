create or replace function vortex_record.reserve_named_action_creation_locks_internal(
  p_record_type_id uuid,
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
  record_meta jsonb;
  record_type_value jsonb;
  storage_contract_id_value uuid;
  storage_scope_value text;
  field_item jsonb;
  field_settings jsonb;
  counter_row record;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_creations) is distinct from 'array' then
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
    record_meta := vortex_record.resolve_record_action_context_internal(
      (creation ->> 'recordTypeId')::uuid, 'create'
    );
    if pg_catalog.jsonb_typeof(record_meta -> 'recordType') is distinct from 'object' then
      raise exception using errcode = '55000',
        message = 'Named action creation target is unavailable';
    end if;
    record_type_value := record_meta -> 'recordType';
    storage_contract_id_value := (record_meta ->> 'storageContractId')::uuid;
    storage_scope_value := record_meta ->> 'storageScope';
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

  -- L4: every created record's reference-number counter, in one canonical
  -- order, before the subject writer writes the subject's relationship edges
  -- (L6), matching ordinary create's counter-then-edge order. A row is created
  -- at `startingNumber` or left unchanged, and `allocate_reference_number_internal`
  -- then increments the held row, so an abandoned reservation consumes no number.
  for counter_row in
    select distinct
      (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      (item.value ->> 'fieldId')::uuid as field_id,
      (item.value ->> 'applicationRootId')::uuid as application_root_id,
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

revoke all on function vortex_record.reserve_named_action_creation_locks_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.reserve_named_action_creation_locks_internal(uuid, jsonb)
  to vortex_record_adapter;

comment on function vortex_record.reserve_named_action_creation_locks_internal(uuid, jsonb) is
  'Private named-action step: takes every created record''s reference-number counter (L4) before the subject writer writes any relationship edge (L6), so a combined create and subject-link command keeps edge identities as the last lock class, as ordinary create does. Changes no counter value except the creation reservation itself.';
