create or replace function vortex_access.required_platform_permission(p_permission_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  required_permission jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'ownerKind', declaration.owner_kind,
    'ownerId', declaration.owner_id,
    'permissionId', declaration.permission_id
  )
  into strict required_permission
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.permission_key = p_permission_key;

  return required_permission;
exception
  when no_data_found then
    raise exception using errcode = 'P0001',
      message = 'PLATFORM_PERMISSION_DECLARATION_MISSING',
      detail = p_permission_key;
  when too_many_rows then
    raise exception using errcode = 'P0001',
      message = 'PLATFORM_PERMISSION_DECLARATION_AMBIGUOUS',
      detail = p_permission_key;
end
$function$;

alter function vortex_access.required_platform_permission(text) owner to vortex_owner;
revoke all on function vortex_access.required_platform_permission(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.required_platform_permission(text) to postgres, vortex_owner;
