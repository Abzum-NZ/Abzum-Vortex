create or replace function vortex_identity.validate_organization_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_parent_id uuid;
  current_state text;
  tenant_state text;
  parent_state text;
begin
  select organization.parent_organization_id, organization.state
  into current_parent_id, current_state
  from vortex_identity.organizations as organization
  where organization.organization_id = new.organization_id;

  if not found then
    return null;
  end if;

  select tenant.state
  into tenant_state
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id;

  if current_state in ('active', 'suspended')
    and tenant_state in ('archived', 'removal_pending') then
    raise exception using
      errcode = '23514',
      message = 'An unresolved organisation requires a live tenant';
  end if;

  if current_parent_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = new.tenant_id
      and parent.organization_id = current_parent_id;

    if current_state in ('active', 'suspended')
      and parent_state in ('archived', 'removal_pending') then
      raise exception using
        errcode = '23514',
        message = 'An unresolved organisation requires a live parent';
    end if;
  end if;

  if current_state in ('archived', 'removal_pending')
    and exists (
      select 1
      from vortex_identity.organizations as child
      where child.tenant_id = new.tenant_id
        and child.parent_organization_id = new.organization_id
        and child.state in ('active', 'suspended')
    ) then
    raise exception using
      errcode = '23514',
      message = 'An archived or removal-pending organisation cannot retain unresolved children';
  end if;

  return null;
end
$function$;

revoke execute on function vortex_identity.validate_organization_lifecycle() from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.validate_organization_lifecycle() is null;

alter function vortex_identity.validate_organization_lifecycle() owner to vortex_identity_owner;
