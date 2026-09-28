create or replace function vortex_identity.adopt_tenant(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_tenant_steward_identity_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  tenant_revision bigint;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_assignment_id uuid;
begin
  if not vortex_context.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(p_tenant_steward_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant adoption input is invalid';
  end if;

  select tenant.revision into tenant_revision
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'adopt_tenant'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(receipt.subject_ids);
    if replay_assignment_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_tenant'::text, p_tenant_id,
      replay_assignment_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, replay_assignment_id)],
      receipt.receipt_id, receipt.accepted_at;
    return;
  end if;

  if exists (
    select 1 from vortex_identity.accepted_administration_receipts as prior
    where (prior.tenant_id = p_tenant_id and prior.operation_key = 'adopt_tenant')
      or (prior.cluster_id is not null and prior.operation_key = 'provision_tenant'
          and prior.subject_ids @> array[p_tenant_id])
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_identity.identity_projections as projection
  where projection.identity_id = p_tenant_steward_identity_id
    and projection.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  if exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.state = 'active'
      and not vortex_access.organization_has_permanent_steward(
        organization.organization_id, operation_at
      )
  ) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_assignment_id, p_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values (p_tenant_id, tenant_revision), (new_assignment_id, 1::bigint))
    as result(subject_id, subject_revision);
  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, p_operator_actor_id, p_tenant_id, 'adopt_tenant',
    p_duplicate_key, p_command_fingerprint, result_subject_ids,
    result_subject_revisions, operation_at
  );
  return query select 'accepted'::text, 'adopt_tenant'::text, p_tenant_id,
    new_assignment_id, 1::bigint, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) is 'Configured-system-only explicit tenant stewardship adoption; it creates no organisation authority.';

alter function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) owner to postgres;
