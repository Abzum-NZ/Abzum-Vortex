create or replace function vortex_access.assign_capability_policy(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_assignment_id uuid,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text, assignment_id uuid, policy_id uuid, policy_revision bigint,
  tenant_id uuid, organization_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  established jsonb;
  acting_actor_id uuid := p_actor_identity_id;
  decision record;
  policy vortex_access.capability_policy_definitions%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or (p_actor_organization_account_id is not null
      and not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text))
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    -- Organisation administration carries Activity evidence; tenant
    -- administration is evidenced by its accepted-administration receipt and
    -- has no organisation Activity ledger to append to.
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_context.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability policy assignment is invalid';
  end if;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  established := vortex_access.capability_policy_actor_context(
    p_tenant_id, p_organization_id, p_actor_identity_id, p_actor_organization_account_id
  );
  if p_organization_id is null then
    perform vortex_identity.require_current_tenant_capability(
      p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
    );
  else
    select evaluated.* into strict decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.assignments.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;
    if decision.outcome is distinct from 'eligible'
      or decision.operation_key is distinct from 'platform.organization.assignments.manage'
      or decision.organization_id is distinct from p_organization_id
      or decision.organization_account_id is distinct from p_actor_organization_account_id
      or decision.access_version is distinct from (established ->> 'accessVersion')::bigint
      or decision.correlation_id is distinct from (established ->> 'correlationId')::uuid then
      raise exception using errcode = '42501',
        message = 'Capability policy organization authority is unavailable';
    end if;
    acting_actor_id := p_actor_organization_account_id;
    perform 1 from vortex_identity.organizations organization
    where organization.organization_id = p_organization_id
      and organization.tenant_id = p_tenant_id and organization.state = 'active';
    if not found then
      raise exception using errcode = '42501', message = 'Capability policy organization is unavailable';
    end if;
  end if;
  select definition.* into policy
  from vortex_access.capability_policy_definitions definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id
    and definition.revision = p_policy_revision;
  if not found then
    raise exception using errcode = 'V3101',
      message = 'Capability policy definition revision is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'assign_capability_policy',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_policy_id::text, p_policy_revision::text, p_starts_at::text,
      coalesce(p_expires_at::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = acting_actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'assign_capability_policy'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability policy assignment duplicate conflicts';
    end if;
    return query select 'replayed'::text, assignment.assignment_id, assignment.policy_id,
      assignment.policy_revision, assignment.tenant_id, assignment.organization_id,
      assignment.revision, receipt.receipt_id, receipt.accepted_at
    from vortex_access.capability_policy_assignments assignment
    where assignment.assignment_id = p_assignment_id
      and assignment.revision = receipt.subject_revisions[1];
    if not found then
      raise exception using errcode = '42501', message = 'Capability policy assignment replay is unavailable';
    end if;
    return;
  end if;
  if exists (
    select 1 from vortex_access.capability_policy_assignments assignment
    where assignment.tenant_id = p_tenant_id
      and assignment.organization_id is not distinct from p_organization_id
      and assignment.capability_key = policy.capability_key
      and assignment.unit = policy.unit and assignment.revoked_at is null
  ) then
    raise exception using errcode = '23505', message = 'Capability policy assignment already exists';
  end if;
  insert into vortex_access.capability_policy_assignments(
    assignment_id, tenant_id, organization_id, policy_id, policy_revision,
    capability_key, unit, starts_at, expires_at, revision, assigned_at,
    assigned_by_actor_id, assignment_correlation_id, changed_at,
    changed_by_actor_id, change_correlation_id
  ) values (
    p_assignment_id, p_tenant_id, p_organization_id, p_policy_id, p_policy_revision,
    policy.capability_key, policy.unit, p_starts_at, p_expires_at, 1, evaluated_at,
    acting_actor_id, correlation, evaluated_at, acting_actor_id, correlation
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, acting_actor_id, p_tenant_id, 'assign_capability_policy', p_duplicate_key,
    command_fingerprint, array[p_assignment_id], array[1::bigint], evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, p_policy_id]) as subject(subject_id);
    activity_result := vortex_activity.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'organization_account', acting_actor_id,
      'assign_capability_policy', activity_subjects, array[]::uuid[], vortex_context.channel(),
      (established ->> 'correlationId')::uuid, 'completed'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Capability policy assignment Activity is stale';
    end if;
  end if;
  return query select 'accepted'::text, p_assignment_id, p_policy_id, p_policy_revision,
    p_tenant_id, p_organization_id, 1::bigint, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.assign_capability_policy(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.assign_capability_policy(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, uuid
) to vortex_request;

comment on function vortex_access.assign_capability_policy(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, uuid
) is
  'Protected capability-policy assignment command: establishes administrator authority from the request context, writes the assignment and its accepted receipt, and records content-free Activity for an organisation scope.';
