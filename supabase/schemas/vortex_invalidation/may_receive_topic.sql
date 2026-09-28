create or replace function vortex_invalidation.may_receive_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.identity_projections as projection
    join vortex_identity.organization_accounts as account
      on account.identity_id = projection.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where projection.identity_id = auth.uid()
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
      and organization.organization_id = vortex_invalidation.topic_organization_id(p_topic)
      and vortex_invalidation.application_is_installed(
        organization.organization_id,
        vortex_invalidation.topic_application_root_id(p_topic)
      )
  )
$function$;

revoke all on function vortex_invalidation.may_receive_topic(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.may_receive_topic(text)
  to authenticated;

comment on function vortex_invalidation.may_receive_topic(text) is
  'Authorises one authenticated identity to read a private topic only for an active organisation account it holds and an application currently installed there.';

alter function vortex_invalidation.may_receive_topic(text)
  owner to postgres;
