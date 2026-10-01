begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
create or replace function vortex_record.total_dependency_contract_internal(
  p_record_types jsonb,
  p_relationships jsonb,
  p_target_record_type_id uuid,
  p_total_field jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  relationship_id_value uuid;
  relationship_value jsonb;
  source_type_value jsonb;
  source_type_id uuid;
  source_ids jsonb := '[]'::jsonb;
  source_field_id text;
begin
  if p_target_record_type_id is null
    or pg_catalog.jsonb_typeof(p_record_types) <> 'array'
    or pg_catalog.jsonb_typeof(p_relationships) <> 'array'
    or pg_catalog.jsonb_typeof(p_total_field) <> 'object'
    or p_total_field ->> 'type' <> 'total'
    or not pg_catalog.pg_input_is_valid(
      p_total_field #>> '{settings,relationshipId}', 'uuid'
    ) then
    return null;
  end if;
  relationship_id_value := (p_total_field #>> '{settings,relationshipId}')::uuid;

  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(p_relationships) as item(value)
  where pg_catalog.lower(item.value ->> 'relationshipId') =
      pg_catalog.lower(relationship_id_value::text)
    and vortex_record.relationship_declares_target_internal(
      item.value, p_target_record_type_id
    );
  if relationship_value is null
    or not pg_catalog.pg_input_is_valid(
      relationship_value ->> 'fromRecordTypeId', 'uuid'
    ) then
    return null;
  end if;
  source_type_id := (relationship_value ->> 'fromRecordTypeId')::uuid;
  select item.value into source_type_value
  from pg_catalog.jsonb_array_elements(p_record_types) as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(source_type_id::text);
  if source_type_value is null
    or not pg_catalog.pg_input_is_valid(
      source_type_value ->> 'storageContractId', 'uuid'
    )
    or source_type_value ->> 'storageScope' not in (
      'organization_shared', 'application_contained'
    ) then
    return null;
  end if;

  if p_total_field #>> '{settings,operation}' <> 'count' then
    source_field_id := p_total_field #>> '{settings,fieldId}';
    if not pg_catalog.pg_input_is_valid(source_field_id, 'uuid') then
      return null;
    end if;
    source_ids := source_ids || pg_catalog.jsonb_build_array(
      pg_catalog.lower(source_field_id)
    );
  end if;

  -- Condition leaves are field operands.  The compiler has already validated
  -- their shape; repeat only the exact extraction here so malformed facts
  -- cannot widen a projection.
  source_ids := source_ids || coalesce((
    with recursive nodes(value) as (
      select p_total_field -> 'settings' -> 'filter'
      union all
      select child.value
      from nodes
      cross join lateral (
        select entry.value from pg_catalog.jsonb_each(nodes.value) as entry(key, value)
        where pg_catalog.jsonb_typeof(nodes.value) = 'object'
        union all
        select entry.value from pg_catalog.jsonb_array_elements(nodes.value) as entry(value)
        where pg_catalog.jsonb_typeof(nodes.value) = 'array'
      ) as child
      where nodes.value is not null
    )
    select pg_catalog.jsonb_agg(pg_catalog.lower(value ->> 'fieldId') order by pg_catalog.lower(value ->> 'fieldId'))
    from nodes
    where value ->> 'source' = 'field'
      and pg_catalog.pg_input_is_valid(value ->> 'fieldId', 'uuid')
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'relationshipId', relationship_id_value,
    'sourceRecordTypeId', source_type_id,
    'sourceStorageContractId', source_type_value -> 'storageContractId',
    'sourceStorageScope', source_type_value -> 'storageScope',
    'sourceFieldIds', coalesce((
      select pg_catalog.jsonb_agg(distinct entry.value order by entry.value)
      from pg_catalog.jsonb_array_elements_text(source_ids) as entry(value)
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.total_dependency_contract_internal(jsonb, jsonb, uuid, jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.total_dependency_contract_internal(jsonb, jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.total_dependency_contract_internal(jsonb, jsonb, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.total_dependency_contract_internal(jsonb, jsonb, uuid, jsonb) is null;
reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
