create or replace function vortex_definition.current_preview_installation_id_internal()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  address_value text;
  context_value jsonb;
  preview_id_value uuid;
begin
  address_value := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if address_value is null then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not pg_catalog.pg_input_is_valid(address_value, 'uuid')
    or context_value is null
    or not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Preview installation address is refused';
  end if;
  select preview.preview_installation_id into preview_id_value
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = address_value::uuid
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp();
  if not found then
    raise exception using errcode = '42501',
      message = 'Preview installation is unavailable';
  end if;
  return preview_id_value;
end
$function$;

alter function vortex_definition.current_preview_installation_id_internal() owner to vortex_owner;

revoke all on function vortex_definition.current_preview_installation_id_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.current_preview_installation_id_internal()
  to vortex_record_adapter;
comment on function vortex_definition.current_preview_installation_id_internal() is
  'The unexpired preview installation the transaction-local preview address names for the validated human Application context, or null without an address; a refused address raises instead of selecting live releases.';
