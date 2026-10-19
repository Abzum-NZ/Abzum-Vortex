create or replace function vortex_access.invalidate_preview_installations_internal(
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or pg_catalog.current_setting('vortex_access.exclusive_organization_id', true)
      is distinct from p_organization_id::text then
    raise exception using errcode = '55000',
      message = 'Preview invalidation requires an exclusive access-change scope';
  end if;

  delete from vortex_definition.preview_installations as preview
  where preview.organization_id = p_organization_id;
end
$function$;

alter function vortex_access.invalidate_preview_installations_internal(uuid) owner to vortex_owner;

revoke all on function vortex_access.invalidate_preview_installations_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.invalidate_preview_installations_internal(uuid)
  to vortex_record_adapter, postgres;
