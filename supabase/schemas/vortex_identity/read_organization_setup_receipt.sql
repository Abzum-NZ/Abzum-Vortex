create or replace function vortex_identity.read_organization_setup_receipt(
  p_receipt_id uuid,
  p_expected_operation text,
  p_expected_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  identity_id uuid,
  operation_key text,
  receipt_id uuid,
  command_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored_receipt vortex_identity.accepted_administration_receipts%rowtype;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_tenant_id uuid;
  resolved_organization_created_at timestamptz;
  resolved_organization_created_by uuid;
  resolved_assignment_id uuid;
  resolved_organization_account_id uuid;
  resolved_account_organization_id uuid;
  resolved_identity_id uuid;
  resolved_account_activated_at timestamptz;
  matched_tenant_count bigint;
  matched_organization_count bigint;
  matched_assignment_count bigint;
  matched_account_count bigint;
  matched_identity_count bigint;
  expected_subject_ids uuid[];
begin
  if p_receipt_id is null
    or p_receipt_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_operation is null
    or p_expected_operation not in ('provision_tenant', 'create_tenant_organization')
    or p_expected_organization_id is null
    or p_expected_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  select stored.*
  into stored_receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.receipt_id = p_receipt_id;
  if not found then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
  if stored_receipt.operation_key is distinct from p_expected_operation then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  if p_expected_operation = 'provision_tenant' then
    if stored_receipt.tenant_id is not null
      or stored_receipt.cluster_id is null
      or pg_catalog.cardinality(stored_receipt.subject_ids) <> 4 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_tenant_count
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored_receipt.subject_ids);
    if matched_tenant_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select tenant.tenant_id
    into resolved_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored_receipt.subject_ids);
    if not exists (
      select 1
      from vortex_identity.tenants as tenant
      where tenant.tenant_id = resolved_tenant_id
        and tenant.created_at = stored_receipt.accepted_at
        and tenant.created_by = stored_receipt.actor_id
    ) then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_organization_count
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if matched_organization_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select organization.organization_id,
      organization.tenant_id,
      organization.created_at,
      organization.created_by
    into resolved_organization_id,
      resolved_organization_tenant_id,
      resolved_organization_created_at,
      resolved_organization_created_by
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if resolved_organization_id is distinct from p_expected_organization_id
      or resolved_organization_tenant_id is distinct from resolved_tenant_id
      or resolved_organization_created_at is distinct from stored_receipt.accepted_at
      or resolved_organization_created_by is distinct from stored_receipt.actor_id then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_assignment_count
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored_receipt.subject_ids)
      and assignment.tenant_id = resolved_tenant_id
      and assignment.granted_at = stored_receipt.accepted_at
      and assignment.granted_by_actor_id = stored_receipt.actor_id
      and assignment.grant_correlation_id = stored_receipt.receipt_id;
    if matched_assignment_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select assignment.assignment_id
    into resolved_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored_receipt.subject_ids)
      and assignment.tenant_id = resolved_tenant_id
      and assignment.granted_at = stored_receipt.accepted_at
      and assignment.granted_by_actor_id = stored_receipt.actor_id
      and assignment.grant_correlation_id = stored_receipt.receipt_id;
  else
    if stored_receipt.tenant_id is null
      or stored_receipt.cluster_id is not null
      or pg_catalog.cardinality(stored_receipt.subject_ids) <> 2 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    resolved_tenant_id := stored_receipt.tenant_id;
    select pg_catalog.count(*)
    into matched_tenant_count
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = resolved_tenant_id;
    if matched_tenant_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_organization_count
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if matched_organization_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select organization.organization_id,
      organization.tenant_id,
      organization.created_at,
      organization.created_by
    into resolved_organization_id,
      resolved_organization_tenant_id,
      resolved_organization_created_at,
      resolved_organization_created_by
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if resolved_organization_id is distinct from p_expected_organization_id
      or resolved_organization_tenant_id is distinct from resolved_tenant_id
      or resolved_organization_created_at is distinct from stored_receipt.accepted_at
      or resolved_organization_created_by is distinct from stored_receipt.actor_id then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
  end if;

  select pg_catalog.count(*)
  into matched_account_count
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = any(stored_receipt.subject_ids);
  if matched_account_count <> 1 then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
  select account.organization_account_id,
    account.organization_id,
    account.identity_id,
    account.activated_at
  into resolved_organization_account_id,
    resolved_account_organization_id,
    resolved_identity_id,
    resolved_account_activated_at
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = any(stored_receipt.subject_ids);
  if resolved_account_organization_id is distinct from resolved_organization_id
    or resolved_account_activated_at is distinct from stored_receipt.accepted_at then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  select pg_catalog.count(*)
  into matched_identity_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = resolved_identity_id;
  if matched_identity_count <> 1 then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  if p_expected_operation = 'provision_tenant' then
    select pg_catalog.array_agg(subject_id order by subject_id)
    into expected_subject_ids
    from (values
      (resolved_tenant_id),
      (resolved_organization_id),
      (resolved_assignment_id),
      (resolved_organization_account_id)
    ) as original_subjects(subject_id);
  else
    select pg_catalog.array_agg(subject_id order by subject_id)
    into expected_subject_ids
    from (values
      (resolved_organization_id),
      (resolved_organization_account_id)
    ) as original_subjects(subject_id);
  end if;
  if stored_receipt.subject_ids is distinct from expected_subject_ids then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  return query
  select resolved_tenant_id,
    resolved_organization_id,
    resolved_organization_account_id,
    resolved_identity_id,
    stored_receipt.operation_key,
    stored_receipt.receipt_id,
    stored_receipt.command_fingerprint;
end
$function$;

revoke execute on function vortex_identity.read_organization_setup_receipt(uuid, text, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.read_organization_setup_receipt(uuid, text, uuid)
  to vortex_runtime;

comment on function vortex_identity.read_organization_setup_receipt(uuid, text, uuid) is
  'Attests one accepted original tenant or child-organisation creation receipt and its immutable Identity subjects without granting setup authority.';

alter function vortex_identity.read_organization_setup_receipt(uuid,text,uuid) owner to postgres;
