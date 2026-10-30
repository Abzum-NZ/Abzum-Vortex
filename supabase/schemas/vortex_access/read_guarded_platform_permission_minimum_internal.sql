create or replace function vortex_access.read_guarded_platform_permission_minimum_internal()
returns table (
  permission_id uuid
)
language sql
stable
security definer
set search_path = ''
as $function$
  select declaration.permission_id
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.owner_id = vortex_access.platform_permission_owner_id()
    and declaration.steward_minimum
  order by declaration.permission_id
$function$;
alter function vortex_access.read_guarded_platform_permission_minimum_internal() owner to vortex_owner;


revoke all on function vortex_access.read_guarded_platform_permission_minimum_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.read_guarded_platform_permission_minimum_internal()
  to postgres;
comment on function vortex_access.read_guarded_platform_permission_minimum_internal() is
  'Returns the complete guarded platform permanent-steward permission identity set only to the authorized postgres caller.';
alter function vortex_access.read_guarded_platform_permission_minimum_internal()
  owner to vortex_owner;
