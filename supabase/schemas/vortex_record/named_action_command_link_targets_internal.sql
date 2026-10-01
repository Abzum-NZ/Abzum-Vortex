create or replace function vortex_record.named_action_command_link_targets_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_submitted_values jsonb,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  sources jsonb;
  source_value jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_id text;
  target_value jsonb;
  target_type jsonb;
  targets jsonb := '[]'::jsonb;
begin
  sources := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id, 'values', p_submitted_values
  ));
  select sources || coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', (item.value ->> 'recordTypeId')::uuid,
      'values', item.value -> 'values'
    ) order by item.ordinality
  ), '[]'::jsonb)
  into sources
  from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
    with ordinality item(value, ordinality);

  for source_value in
    select item.value
    from pg_catalog.jsonb_array_elements(sources) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    select item.value into source_type
    from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') =
      pg_catalog.lower((source_value ->> 'recordTypeId')::uuid::text);
    if source_type is null then return null; end if;
    for relationship_value in
      select item.value
      from pg_catalog.jsonb_array_elements(source_type -> 'relationships') item(value)
      order by pg_catalog.lower(item.value ->> 'fromFieldId') collate "C",
        item.value ->> 'relationshipId'
    loop
      field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
      if not (source_value -> 'values') ? field_id then continue; end if;
      target_value := source_value -> 'values' -> field_id;
      if pg_catalog.jsonb_typeof(target_value) <> 'object' then continue; end if;
      if not pg_catalog.pg_input_is_valid(target_value ->> 'recordTypeId', 'uuid')
        or not pg_catalog.pg_input_is_valid(target_value ->> 'recordId', 'uuid') then
        return null;
      end if;
      select item.value into target_type
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower((target_value ->> 'recordTypeId')::uuid::text);
      if target_type is null then return null; end if;
      targets := targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'sourceRecordTypeId', (source_value ->> 'recordTypeId')::uuid,
        'fromFieldId', field_id,
        'relationshipId', (relationship_value ->> 'relationshipId')::uuid,
        'recordTypeId', (target_value ->> 'recordTypeId')::uuid,
        'recordId', (target_value ->> 'recordId')::uuid,
        'storageContractId', (target_type ->> 'storageContractId')::uuid
      ));
    end loop;
  end loop;
  return targets;
end
$function$;

alter function vortex_record.named_action_command_link_targets_internal(jsonb, uuid, jsonb, jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_command_link_targets_internal(jsonb, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.named_action_command_link_targets_internal(jsonb, uuid, jsonb, jsonb)
  to vortex_record_adapter;

comment on function vortex_record.named_action_command_link_targets_internal(jsonb, uuid, jsonb, jsonb) is null;
