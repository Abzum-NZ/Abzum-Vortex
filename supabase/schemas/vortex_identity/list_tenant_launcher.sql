create or replace function vortex_identity.list_tenant_launcher(
  p_limit integer,
  p_after uuid default null
)
returns table (tenant_id uuid, display_name text)
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
  if p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant launcher request is invalid';
  end if;
  if not exists (
    select 1
    from vortex_identity.identity_projections projection
    where projection.identity_id = actor_identity_id
      and projection.state = 'active'
  ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  return query
  select tenant.tenant_id, tenant.display_name
  from vortex_identity.tenants tenant
  where tenant.state = 'active'
    and (p_after is null or tenant.tenant_id > p_after)
    and exists (
      select 1
      from vortex_identity.tenant_administrator_assignments assignment
      where assignment.tenant_id = tenant.tenant_id
        and assignment.identity_id = actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    )
  order by tenant.tenant_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_launcher(integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_launcher(integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_launcher(integer, uuid) is
  'Bounded active tenant contexts visible through the bound request context person''s effective structural assignments.';
