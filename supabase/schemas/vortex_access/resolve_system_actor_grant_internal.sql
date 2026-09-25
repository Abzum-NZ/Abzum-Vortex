create or replace function vortex_access.resolve_system_actor_grant_internal(
  p_system_actor_id uuid,
  p_operation_key text,
  p_organization_id uuid,
  p_flow_id uuid,
  p_scope_key text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  grant_state text;
begin
  if p_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_system_actor_id::text)
    or p_operation_key is null
    or pg_catalog.octet_length(p_operation_key) not between 1 and 128
    or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_scope_key is not null and (
      pg_catalog.octet_length(p_scope_key) not between 1 and 128
      or p_scope_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )) then
    raise exception using errcode = '22023', message = 'System actor grant lookup is invalid';
  end if;

  select actor_grant.state into grant_state
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.system_actor_id = p_system_actor_id
    and actor_grant.operation_key = p_operation_key
    and actor_grant.organization_id is not distinct from p_organization_id
    and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
    and actor_grant.scope_key is not distinct from p_scope_key
  order by (actor_grant.state = 'active') desc
  limit 1
  for share;

  return grant_state;
end
$function$;

revoke all on function vortex_access.resolve_system_actor_grant_internal(
  uuid, text, uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.resolve_system_actor_grant_internal(
  uuid, text, uuid, uuid, text
) is
  'Owner-only lookup of the one system actor grant for an exact actor, protected operation, organisation, optional flow and scope subject; returns active, revoked or null and never derives authority from the session role.';
