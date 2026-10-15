create or replace function vortex_record.has_bounded_system_projection_reader_internal(
  p_storage_contract_id uuid,
  p_sort_key text
)
returns boolean
language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from vortex_record.storage_catalogue as storage
    join vortex_record.protected_read_model_views as registered
      on registered.protected_read_model_key = storage.protected_read_model_key
    where storage.storage_contract_id = p_storage_contract_id
      and storage.physical_schema_token = 'system_projection'
      and storage.state = 'active'
      and p_sort_key = any(registered.cursor_sort_keys)
      and pg_catalog.to_regprocedure(pg_catalog.format(
        '%I.%I(uuid[],text,text,jsonb,integer)', registered.reader_schema,
        registered.reader_function
      )) is not null
  );
$function$;

alter function vortex_record.has_bounded_system_projection_reader_internal(uuid, text)
  owner to vortex_owner;
revoke all on function vortex_record.has_bounded_system_projection_reader_internal(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.has_bounded_system_projection_reader_internal(uuid, text)
  to vortex_record_adapter;
