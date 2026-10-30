create or replace function vortex_platform.resolve_backend_actor(
  p_organization_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  found_account record;
begin
  if p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_id::text) then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'actor_unknown');
  end if;

  select account.identity_id, account.state as account_state,
    organization.state as organization_state, tenant.state as tenant_state,
    identity.state as identity_state
  into found_account
  from vortex_identity.organization_accounts as account
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
  where account.organization_account_id = p_actor_id
    and account.organization_id = p_organization_id;

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'actor_unknown');
  end if;
  if found_account.account_state is distinct from 'active'
    or found_account.identity_state is distinct from 'active' then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'actor_not_active');
  end if;
  if found_account.organization_state is distinct from 'active'
    or found_account.tenant_state is distinct from 'active' then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'organization_not_active');
  end if;
  return pg_catalog.jsonb_build_object('kind', 'available', 'identityId', found_account.identity_id);
end
$function$;
alter function vortex_platform.resolve_backend_actor(uuid, uuid) owner to vortex_owner;

revoke all on function vortex_platform.resolve_backend_actor(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.resolve_backend_actor(uuid, uuid) to vortex_runtime;

comment on function vortex_platform.resolve_backend_actor(uuid, uuid) is
  'Reads the identity behind one organisation account for a back-end run and refuses, with a named reason, an account, identity, organisation or tenant that is not active; the run never copies a session.';
