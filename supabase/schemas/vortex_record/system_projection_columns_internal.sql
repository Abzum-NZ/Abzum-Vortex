create or replace function vortex_record.system_projection_columns_internal(p_record_type jsonb)
returns text
language plpgsql immutable security definer set search_path = ''
as $function$
declare
  field_value jsonb;
  field_id uuid;
  database_type text;
  columns_sql text := 'organisation_id uuid, module_root_id uuid, record_type_id uuid,
    storage_contract_id uuid, record_id uuid, application_root_id uuid,
    definition_revision bigint, owner_organisation_account_id uuid, owner_group_id uuid,
    lifecycle_state text, concurrency_number bigint, created_at timestamptz, created_by uuid,
    updated_at timestamptz, updated_by uuid, deleted_at timestamptz, deleted_by uuid,
    removal_due_at timestamptz';
begin
  if pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_record_type -> 'systemProjection') is distinct from 'object' then
    raise exception using errcode = '55000', message = 'Protected projection definition is invalid';
  end if;
  for field_value in
    select item.value from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := (field_value ->> 'fieldId')::uuid;
    database_type := vortex_record.database_value_type(field_value);
    if not vortex_platform.is_non_nil_uuid(field_id::text) or database_type is null then
      raise exception using errcode = '55000', message = 'Protected projection field is invalid';
    end if;
    columns_sql := columns_sql || pg_catalog.format(', %I %s',
      'f_' || pg_catalog.replace(field_id::text, '-', ''),
      vortex_record.sql_value_type(database_type));
  end loop;
  return columns_sql;
end
$function$;

alter function vortex_record.system_projection_columns_internal(jsonb) owner to vortex_owner;
revoke all on function vortex_record.system_projection_columns_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.system_projection_columns_internal(jsonb)
  to vortex_record_adapter, postgres;
