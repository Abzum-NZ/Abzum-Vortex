create or replace function vortex_access.lock_active_record_ownership_target_internal(
  p_kind text,
  p_target_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  matched boolean;
begin
  if p_kind is null
    or p_kind not in ('organization_account', 'group')
    or p_target_id is null
    or p_target_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_kind = 'organization_account' then
    select true into matched
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where account.organization_id = (context_value ->> 'organizationId')::uuid
      and account.organization_account_id = p_target_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of account, projection;
  else
    select true into matched
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
      and organization_group.group_id = p_target_id
      and organization_group.state = 'active'
    for share of organization_group;
  end if;
  return coalesce(matched, false);
end
$function$;

comment on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) is
  'Private exact active same-organisation account or Group target check for the fixed Record ownership-transfer operation.';

revoke all on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) to vortex_record_adapter;
