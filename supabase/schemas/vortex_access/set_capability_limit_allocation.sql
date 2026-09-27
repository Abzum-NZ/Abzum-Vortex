create or replace function vortex_access.set_capability_limit_allocation(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_assignment_id uuid,
  p_capability_key text,
  p_unit text,
  p_quantity_limit numeric,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, organization_id uuid,
  capability_key text, unit text, quantity_limit numeric, ceiling_policy_id uuid,
  ceiling_policy_revision bigint, revision bigint, correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  request_correlation_id uuid;
  live_ceiling record;
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity_limit)
    or (p_expires_at is not null
      and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990)
    -- An organisation allocation is also recorded in that organisation's
    -- Activity history; a tenant-wide allocation has no organisation ledger.
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_context.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability allocation is invalid';
  end if;
  -- The acting person comes only from the bound request context, and the
  -- Authority is the dedicated tenant allocation permission. An organisation
  -- role, delegation or organisation administrator cannot supply it.
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  request_correlation_id := (vortex_context.current_context() ->> 'correlationId')::uuid;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.capability_limits.allocate', evaluated_at
  );
  if p_expires_at is not null and p_expires_at <= evaluated_at then
    raise exception using errcode = '22023', message = 'Capability allocation is invalid';
  end if;
  if p_organization_id is not null then
    perform 1 from vortex_identity.organizations organization
    where organization.organization_id = p_organization_id
      and organization.tenant_id = p_tenant_id and organization.state = 'active'
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'Capability allocation organization is unavailable';
    end if;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'set_capability_limit_allocation',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_capability_key, p_unit, p_quantity_limit::text, coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'set_capability_limit_allocation'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability allocation duplicate conflicts';
    end if;
    select stored.* into evidence
    from vortex_access.capability_limit_changes as stored
    where stored.change_id = receipt.receipt_id;
    if not found then
      raise exception using errcode = '42501', message = 'Capability allocation replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.organization_id, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.policy_id, evidence.policy_revision,
      evidence.assignment_revision, receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  -- An allocation is only ever made beneath a live platform ceiling and never
  -- above it. A later lower ceiling still bounds it, because resolution takes
  -- the lowest applicable limit.
  select bound.* into live_ceiling
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at, true
  ) as bound
  where bound.limit_source = 'platform_ceiling';
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
  end if;
  if p_quantity_limit > live_ceiling.quantity_limit then
    raise exception using errcode = 'V3104',
      message = 'Capability allocation exceeds the platform ceiling';
  end if;
  if p_expected_revision is null then
    if exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.organization_id is not distinct from p_organization_id
        and assignment.assignment_kind = 'allocation'
        and assignment.capability_key = p_capability_key
        and assignment.unit = p_unit and assignment.revoked_at is null
    ) or exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.assignment_id = p_assignment_id
    ) then
      raise exception using errcode = '23505', message = 'Capability allocation already exists';
    end if;
    resulting_revision := 1;
    insert into vortex_access.capability_policy_assignments(
      assignment_id, tenant_id, organization_id, policy_id, policy_revision,
      capability_key, unit, starts_at, expires_at, revision, assigned_at,
      assigned_by_actor_id, assignment_correlation_id, changed_at,
      changed_by_actor_id, change_correlation_id, assignment_kind, allocated_quantity
    ) values (
      p_assignment_id, p_tenant_id, p_organization_id, live_ceiling.policy_id,
      live_ceiling.policy_revision, p_capability_key, p_unit, evaluated_at, p_expires_at,
      resulting_revision, evaluated_at, actor_identity_id, correlation, evaluated_at,
      actor_identity_id, correlation, 'allocation', p_quantity_limit
    );
  else
    select assignment.* into target
    from vortex_access.capability_policy_assignments as assignment
    where assignment.assignment_id = p_assignment_id for update;
    if not found or target.tenant_id <> p_tenant_id
      or target.organization_id is distinct from p_organization_id
      or target.assignment_kind <> 'allocation'
      or target.capability_key <> p_capability_key or target.unit <> p_unit then
      raise exception using errcode = 'V3101', message = 'Capability allocation is unavailable';
    end if;
    if target.revoked_at is not null or target.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Capability allocation is stale';
    end if;
    resulting_revision := p_expected_revision + 1;
    update vortex_access.capability_policy_assignments as assignment
    set allocated_quantity = p_quantity_limit, expires_at = p_expires_at,
        policy_id = live_ceiling.policy_id, policy_revision = live_ceiling.policy_revision,
        revision = resulting_revision, changed_at = evaluated_at,
        changed_by_actor_id = actor_identity_id, change_correlation_id = correlation
    where assignment.assignment_id = p_assignment_id;
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, actor_identity_id, p_tenant_id, 'set_capability_limit_allocation',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[resulting_revision], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, p_organization_id,
    case when resulting_revision = 1 then 'allocation_set' else 'allocation_revised' end,
    'tenant_administrator', actor_identity_id, live_ceiling.policy_id, live_ceiling.policy_revision,
    p_assignment_id, resulting_revision, p_capability_key, p_unit, p_quantity_limit,
    p_expires_at, vortex_context.channel(), request_correlation_id, evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, live_ceiling.policy_id]) as subject(subject_id);
    activity_result := vortex_activity.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'identity', actor_identity_id,
      'set_capability_limit_allocation', activity_subjects, array[]::uuid[],
      vortex_context.channel(), request_correlation_id, 'completed'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Capability allocation Activity is stale';
    end if;
  end if;
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_organization_id,
    p_capability_key, p_unit, p_quantity_limit, live_ceiling.policy_id, live_ceiling.policy_revision,
    resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) is
  'Tenant capability-limits allocation permission command that allocates, or revises in place, a tenant-wide or organisation limit for one capability, refused above the live platform ceiling; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';
