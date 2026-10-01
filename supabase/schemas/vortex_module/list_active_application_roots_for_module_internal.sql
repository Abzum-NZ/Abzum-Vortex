create or replace function vortex_module.list_active_application_roots_for_module_internal(
  p_organization_id uuid,
  p_module_root_id uuid
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  application_roots uuid[];
begin
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_module_root_id is null or p_module_root_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Active Module consumer scope is invalid';
  end if;

  select coalesce(
    pg_catalog.array_agg(candidate.application_root_id order by candidate.application_root_id),
    array[]::uuid[]
  ) into application_roots
  from (
    select distinct binding.application_root_id
    from vortex_module.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.module_root_id = p_module_root_id
      and binding.state = 'active'
  ) as candidate;

  return application_roots;
end
$function$;

alter function vortex_module.list_active_application_roots_for_module_internal(uuid,uuid)
  owner to vortex_module_owner;
revoke all on function vortex_module.list_active_application_roots_for_module_internal(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_event_owner, vortex_definition_owner, vortex_record_owner,
  vortex_record_adapter;
grant execute on function vortex_module.list_active_application_roots_for_module_internal(
  uuid, uuid
) to postgres;
comment on function vortex_module.list_active_application_roots_for_module_internal(uuid,uuid) is
  'Returns the distinct sorted active Application root candidates bound to one Module in one organisation; callers must resolve each candidate through the exact active-scope reader under the canonical binding lock.';
