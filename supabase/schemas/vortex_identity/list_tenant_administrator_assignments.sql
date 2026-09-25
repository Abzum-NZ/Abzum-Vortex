create or replace function vortex_identity.list_tenant_administrator_assignments(
  p_tenant_id uuid,
  p_limit integer,
  p_after uuid default null
)
returns table (assignment_id uuid, identity_id uuid, capability_keys text[], starts_at timestamptz, expires_at timestamptz, revision bigint, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant assignment request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.administrators.read',
    evaluated_at
  );
  return query
  select assignment.assignment_id, assignment.identity_id, assignment.capability_keys,
    assignment.starts_at, assignment.expires_at, assignment.revision,
    case when assignment.revoked_at is not null and assignment.revoked_at <= evaluated_at then 'revoked'
      when assignment.starts_at > evaluated_at then 'scheduled'
      when assignment.expires_at is not null and assignment.expires_at <= evaluated_at then 'expired'
      else 'active' end
  from vortex_identity.tenant_administrator_assignments assignment
  where assignment.tenant_id = p_tenant_id
    and (p_after is null or assignment.assignment_id > p_after)
  order by assignment.assignment_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid) is
  'Bounded deterministic same-tenant assignment read under the bound request context person''s exact administrators.read capability.';
