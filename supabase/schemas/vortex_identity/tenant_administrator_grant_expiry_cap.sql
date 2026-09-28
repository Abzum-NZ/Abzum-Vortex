create or replace function vortex_identity.tenant_administrator_grant_expiry_cap(
  p_actor_identity_id uuid,
  p_tenant_id uuid,
  p_capabilities text[],
  p_evaluated_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case when pg_catalog.min(bound.latest_expiry) = 'infinity'::timestamptz
      then null else pg_catalog.min(bound.latest_expiry) end
  from (
    select (
      select pg_catalog.max(coalesce(assignment.expires_at, 'infinity'::timestamptz))
      from vortex_identity.tenant_administrator_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.identity_id = p_actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= p_evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
        and required.capability_key = any(assignment.capability_keys)
    ) as latest_expiry
    from pg_catalog.unnest(
      pg_catalog.array_append(p_capabilities, 'platform.tenant.administrators.manage')
    ) as required(capability_key)
  ) as bound
$function$;

revoke execute on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) is 'Private: the earliest time the actor loses any of the given tenant capabilities or platform.tenant.administrators.manage, from current assignments; null when none of them expires.';

alter function vortex_identity.tenant_administrator_grant_expiry_cap(uuid,uuid,text[],timestamp with time zone) owner to vortex_identity_owner;
