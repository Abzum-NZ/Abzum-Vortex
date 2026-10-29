CREATE OR REPLACE FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
declare
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  lifecycle_state_value text;
begin
  if p_record_type_id is null or p_record_id is null or p_organization_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') is distinct from 'array' then
    return false;
  end if;
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then
    return false;
  end if;
  select item.value ->> 'lifecycleState' into lifecycle_state_value
  from pg_catalog.jsonb_array_elements(coalesce(p_catalogue -> 'proposedRecords', '[]'::jsonb)) as item(value)
  where item.value ->> 'recordTypeId' = p_record_type_id::text
    and item.value ->> 'recordId' = p_record_id::text;
  if found then return lifecycle_state_value <> 'active'; end if;
  select stored.* into catalogue_row
  from vortex_record.storage_catalogue as stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then
    return false;
  end if;
  execute pg_catalog.format(
    'select stored.lifecycle_state from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.application_root_id is not distinct from $3',
    catalogue_row.physical_table_token
  ) into lifecycle_state_value using
    p_organization_id, p_record_id,
    case when record_type ->> 'storageScope' = 'application_contained'
      then p_application_root_id else null end;
  return lifecycle_state_value is not null and lifecycle_state_value <> 'active';
end
$_$;
alter function vortex_record.relationship_total_source_is_retained_internal(jsonb,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
