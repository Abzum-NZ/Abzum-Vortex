create or replace function vortex_record.read_current_preview_installation_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  address_value text;
  preview_value jsonb;
begin
  address_value := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if address_value is null then
    return null;
  end if;
  if not pg_catalog.pg_input_is_valid(address_value, 'uuid') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  preview_value := vortex_module.read_preview_record_installation_internal(
    address_value::uuid
  );
  if preview_value is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  return preview_value;
end
$function$;

alter function vortex_record.read_current_preview_installation_internal()
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_current_preview_installation_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_record.read_current_preview_installation_internal()
  to vortex_record_owner, vortex_record_adapter;
comment on function vortex_record.read_current_preview_installation_internal() is
  'Resolves the transaction-local preview address only after the module ledger validates the same human identity, organisation account and Application context and confirms the preview is unexpired.';
