create or replace function vortex_definition.read_current_active_installation()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_address text;
  preview_value jsonb;
begin
  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId' then
    raise exception using errcode = '22023', message = 'Active Application context is required';
  end if;
  -- A preview request runs its own installation and never reaches the live one.
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if preview_address is not null then
    if not pg_catalog.pg_input_is_valid(preview_address, 'uuid') then
      raise exception using errcode = '42501', message = 'Preview installation address is refused';
    end if;
    preview_value := vortex_definition.read_preview_record_installation_internal(
      preview_address::uuid
    );
    if preview_value is null then
      raise exception using errcode = '42501', message = 'Preview installation is unavailable';
    end if;
    return preview_value;
  end if;
  return vortex_definition.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid
  );
end
$function$;

alter function vortex_definition.read_current_active_installation() owner to vortex_owner;

revoke all on function vortex_definition.read_current_active_installation() from public;
grant execute on function vortex_definition.read_current_active_installation() to vortex_request;
grant execute on function vortex_definition.read_current_active_installation() to vortex_record_adapter;
grant execute on function vortex_definition.read_current_active_installation() to postgres;
grant execute on function vortex_definition.read_current_active_installation() to vortex_owner;
comment on function vortex_definition.read_current_active_installation() is
  'Returns the complete exact Module binding set the validated human Application context runs: the active installation, or the preview installation its transaction-local address names.';
