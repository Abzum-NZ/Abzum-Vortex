create or replace function vortex_access.list_visible_group_link_labels(p_record_ids uuid[])
returns table (record_id uuid, display_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  visible_organization_id uuid;
begin
  begin
    select scope.organization_id into strict visible_organization_id
    from vortex_access.organization_groups_administration_scope() as scope;
  exception
    when insufficient_privilege then
      return;
  end;

  return query
  select organization_group.group_id, organization_group.label
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = visible_organization_id
    and organization_group.group_id = any(p_record_ids)
    and pg_catalog.length(pg_catalog.btrim(organization_group.label)) > 0;
end
$function$;

revoke all on function vortex_access.list_visible_group_link_labels(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_visible_group_link_labels(uuid[]) to vortex_request;

comment on function vortex_access.list_visible_group_link_labels(uuid[]) is
  'Returns labels only for requested groups visible through the current viewer-permitted group directory.';

alter function vortex_access.list_visible_group_link_labels(uuid[]) owner to vortex_owner;
grant execute on function vortex_access.list_visible_group_link_labels(uuid[]) to postgres;
