create or replace function vortex_record.read_system_projection_rows_internal(
  p_storage_contract_id uuid,
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  reader_schema text;
  reader_function text;
begin
  select registered.reader_schema, registered.reader_function
  into reader_schema, reader_function
  from vortex_record.storage_catalogue as storage
  join vortex_record.protected_read_model_views as registered
    on registered.protected_read_model_key = storage.protected_read_model_key
  where storage.storage_contract_id = p_storage_contract_id
    and storage.physical_schema_token = 'system_projection'
    and storage.state = 'active';
  if not found then
    raise exception using errcode = '55000',
      message = 'Protected projection reader is unavailable';
  end if;

  -- Every registered protected projection reader has the one bounded signature.
  return query execute pg_catalog.format(
    'select projected.* from %I.%I($1, $2, $3, $4, $5) as projected',
    reader_schema, reader_function
  ) using p_record_ids, p_sort_key, p_direction, p_after, p_limit;
end
$function$;

alter function vortex_record.read_system_projection_rows_internal(
  uuid, uuid[], text, text, jsonb, integer
) owner to vortex_owner;

revoke all on function vortex_record.read_system_projection_rows_internal(
  uuid, uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.read_system_projection_rows_internal(
  uuid, uuid[], text, text, jsonb, integer
) to vortex_record_adapter;
