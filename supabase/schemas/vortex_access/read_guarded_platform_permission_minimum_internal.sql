create or replace function vortex_access.read_guarded_platform_permission_minimum_internal()
returns table (
  permission_id uuid,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select declaration.permission_id, declaration.meaning_fingerprint
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    and declaration.steward_minimum
  order by declaration.permission_id
$function$;

revoke all on function vortex_access.read_guarded_platform_permission_minimum_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.read_guarded_platform_permission_minimum_internal()
  to postgres;
comment on function vortex_access.read_guarded_platform_permission_minimum_internal() is
  'Returns the complete guarded platform permanent-steward permission identity and meaning set only to the authorized postgres caller.';
alter function vortex_access.read_guarded_platform_permission_minimum_internal()
  owner to vortex_access_owner;
