create or replace function vortex_identity.resolve_active_organization_account(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_assignment_id uuid;
  resolved_account_id uuid;
  account_state text;
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  inserted_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation selection is invalid';
  end if;

  select organization.tenant_id
  into resolved_tenant_id
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of identity, organization, tenant;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select account.organization_account_id, account.state
  into resolved_account_id, account_state
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id
    and account.organization_id = p_organization_id
  for share;
  if found then
    if account_state = 'active' then
      return query select resolved_tenant_id, p_organization_id,
        resolved_account_id;
      return;
    end if;
    if account_state = 'suspended'
      and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        p_identity_id, evaluated_at
      ) is not null then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select assignment.assignment_id
  into resolved_assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.identity_id = p_identity_id
    and assignment.revoked_at is null
    and assignment.granted_at <= evaluated_at
  for share of assignment;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision,
    provisioning_kind, provisioning_assignment_id, provisioned_by_identity_id
  ) values (
    pg_catalog.gen_random_uuid(), p_organization_id, p_identity_id, null,
    'active', null, null, evaluated_at, evaluated_at, evaluated_at,
    p_identity_id, new_correlation_id, 1, 'vortex_super_administrator',
    resolved_assignment_id, p_identity_id
  )
  on conflict (organization_id, identity_id) do nothing
  returning organization_account_id into inserted_account_id;

  if inserted_account_id is null then
    select account.organization_account_id, account.state
    into resolved_account_id, account_state
    from vortex_identity.organization_accounts as account
    where account.identity_id = p_identity_id
      and account.organization_id = p_organization_id
    for share;
    if account_state = 'active' then
      return query select resolved_tenant_id, p_organization_id,
        resolved_account_id;
      return;
    end if;
    if account_state = 'suspended' then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  perform vortex_activity.append_organization_activity_entry(
    p_organization_id, pg_catalog.gen_random_uuid(), evaluated_at,
    'identity', p_identity_id, 'super_administrator_account_provisioned',
    array(
      select subject_id
      from pg_catalog.unnest(array[
        p_organization_id, inserted_account_id, resolved_assignment_id
      ]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], 'web', new_correlation_id, 'completed'
  );

  return query select resolved_tenant_id, p_organization_id,
    inserted_account_id;
end
$function$;

revoke all on function vortex_identity.resolve_active_organization_account(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_identity.resolve_active_organization_account(uuid, uuid) is
  'Returns an active local account or transactionally provisions one for an assigned Vortex super administrator with immutable provenance and Activity evidence.';
