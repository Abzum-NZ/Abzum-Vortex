create or replace function vortex_access.lock_system_projection_link_target_internal(
  p_protected_read_model_key text,
  p_target_record_id uuid,
  p_organization_id uuid
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
  if p_protected_read_model_key is null
    or p_protected_read_model_key not in ('organization_accounts', 'groups')
    or p_target_record_id is null
    or p_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or not exists (
      select 1
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = p_protected_read_model_key
        and (
          (p_protected_read_model_key = 'organization_accounts'
            and registered.reader_schema = 'vortex_access'
            and registered.reader_function = 'list_organization_accounts_projection')
          or (p_protected_read_model_key = 'groups'
            and registered.reader_schema = 'vortex_access'
            and registered.reader_function = 'list_organization_groups_projection')
        )
    ) then
    return false;
  end if;

  if p_protected_read_model_key = 'organization_accounts' then
    select true into matched
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_target_record_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of account, projection;
  else
    select true into matched
    from vortex_access.organization_groups as organization_group
    join vortex_identity.organizations as organization
      on organization.organization_id = organization_group.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_target_record_id
      and organization_group.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of organization_group;
  end if;

  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_access.lock_system_projection_link_target_internal(text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_access.lock_system_projection_link_target_internal(text, uuid, uuid)
  to vortex_record_adapter, vortex_record_owner;

comment on function vortex_access.lock_system_projection_link_target_internal(text, uuid, uuid) is
  'Private protected system-projection link lock: share-locks only an active same-organisation People account and its active identity projection, or an active Group, after confirming the registered reader and current organisation; read authority remains with the Record access decision.';
