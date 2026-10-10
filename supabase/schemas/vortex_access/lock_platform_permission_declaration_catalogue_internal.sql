create or replace function vortex_access.lock_platform_permission_declaration_catalogue_internal()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  lock table vortex_access.platform_permission_declarations in share mode;
end
$function$;
revoke all on function vortex_access.lock_platform_permission_declaration_catalogue_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.lock_platform_permission_declaration_catalogue_internal()
  to postgres;
comment on function vortex_access.lock_platform_permission_declaration_catalogue_internal() is
  'Private fixed-scope declaration lock for the owner-only atomic platform permission registration transaction; exposes no rows or caller-selected scope.';
alter function vortex_access.lock_platform_permission_declaration_catalogue_internal()
  owner to vortex_access_owner;
