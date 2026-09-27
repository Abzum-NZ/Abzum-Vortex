create or replace function vortex_identity.tenant_structural_capability_set_is_canonical(
  p_capability_keys text[]
)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  capability_key text;
  previous_key text;
begin
  if pg_catalog.array_ndims(p_capability_keys) <> 1
    or pg_catalog.array_lower(p_capability_keys, 1) <> 1
    or pg_catalog.cardinality(p_capability_keys) not between 1 and 9 then
    return false;
  end if;

  foreach capability_key in array p_capability_keys loop
    if capability_key is null
      or capability_key not in (
        'platform.tenant.administrators.manage',
        'platform.tenant.administrators.read',
        'platform.tenant.capability_limits.allocate',
        'platform.tenant.capability_limits.read',
        'platform.tenant.hierarchy.read',
        'platform.tenant.organizations.create',
        'platform.tenant.organizations.lifecycle',
        'platform.tenant.organizations.rename',
        'platform.tenant.organizations.reparent'
      )
      or (previous_key is not null and previous_key >= capability_key) then
      return false;
    end if;
    previous_key := capability_key;
  end loop;

  return true;
end
$function$;

revoke all on function vortex_identity.tenant_structural_capability_set_is_canonical(text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_structural_capability_set_is_canonical(text[]) is
  'Validates a canonical nonempty set of tenant capability permissions against the single closed permission set.';

create or replace function vortex_identity.require_current_tenant_capability(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_capability_key text,
  p_evaluated_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from vortex_identity.tenants as tenant
    join vortex_identity.identity_projections as identity
      on identity.identity_id = p_identity_id
    where tenant.tenant_id = p_tenant_id
      and tenant.state = 'active'
      and identity.state = 'active'
      and (
        vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          identity.identity_id, p_evaluated_at
        ) is not null
        or exists (
          select 1
          from vortex_identity.tenant_administrator_assignments as assignment
          where assignment.tenant_id = tenant.tenant_id
            and assignment.identity_id = identity.identity_id
            and assignment.revoked_at is null
            and assignment.starts_at <= p_evaluated_at
            and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
            and (
              p_capability_key = any(assignment.capability_keys)
              or p_capability_key = 'platform.tenant.capability_limits.read'
            )
        )
      )
  ) then
    raise exception using errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz) is
  'Requires one current tenant capability, the default capability-limits read permission for an active tenant administrator, or the independent active Vortex super-administrator assignment.';

create or replace function vortex_access.resolve_effective_capability_policy(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text
)
returns table (
  outcome text,
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  applied_scope text,
  applied_limit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  ceiling_quantity_limit numeric,
  resolved_at timestamptz,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  context_organization_id uuid;
  effective_organization_id uuid;
  actor_identity_id uuid;
  selected record;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit) then
    raise exception using errcode = '22023', message = 'Capability policy resolution is invalid';
  end if;
  context_organization_id := (context ->> 'organizationId')::uuid;
  -- The established organisation always belongs to the resolved scope.  An
  -- organisation-scoped request can never omit its organisation and fall back
  -- to the wider tenant limit that its own allocation narrows.
  effective_organization_id := coalesce(p_organization_id, context_organization_id);
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or effective_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  if effective_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = effective_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  -- Tenant-scoped reads require tenant authority. Organisation-scoped
  -- entitlement reads also serve system actors, which have no person identity.
  if effective_organization_id is null then
    actor_identity_id := vortex_identity.tenant_request_actor_id();
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, p_tenant_id,
      'platform.tenant.capability_limits.read', evaluated_at
    );
  elsif (context ->> 'callerKind') in ('human', 'federated')
    and vortex_context.is_non_nil_uuid(context ->> 'identityId')
    and exists (
      select 1
      from vortex_identity.tenant_administrator_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.identity_id = (context ->> 'identityId')::uuid
        and assignment.revoked_at is null
        and assignment.starts_at <= evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    ) then
    actor_identity_id := vortex_identity.tenant_request_actor_id();
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, p_tenant_id,
      'platform.tenant.capability_limits.read', evaluated_at
    );
  end if;
  -- The effective limit is the lowest of the platform ceiling and every
  -- allocation beneath it; on a tie the narrower scope is reported. No
  -- allocation can raise a limit, and nothing applies without a live ceiling.
  select bound.*,
    max(bound.quantity_limit) filter (where bound.limit_source = 'platform_ceiling')
      over () as ceiling_limit
  into selected
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, effective_organization_id, p_capability_key, p_unit, evaluated_at, false
  ) as bound
  order by bound.quantity_limit, bound.precedence
  limit 1;
  if not found then
    return query select 'refused'::text, p_tenant_id, effective_organization_id,
      p_capability_key, p_unit, null::text, null::text, null::uuid, null::bigint, null::uuid,
      null::bigint, null::numeric, null::numeric, evaluated_at, 'capability_not_assigned'::text;
    return;
  end if;
  return query select 'available'::text, p_tenant_id, effective_organization_id,
    p_capability_key, p_unit, selected.applied_scope, selected.limit_source,
    selected.policy_id, selected.policy_revision, selected.assignment_id,
    selected.assignment_revision, selected.quantity_limit, selected.ceiling_limit,
    evaluated_at, null::text;
end
$function$;

revoke execute on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
  to vortex_request;

comment on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text) is
  'Returns the lowest of the live platform ceiling and the tenant and organisation allocations for the established request scope, the ceiling itself, and which limit applied; tenant administrators require the capability-limits read permission, and an allocation can only narrow the ceiling.';

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

create or replace function vortex_access.revoke_capability_limit_allocation(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, organization_id uuid,
  revision bigint, correlation_id uuid, accepted_at timestamptz
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
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_context.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability allocation revocation is invalid';
  end if;
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
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_limit_allocation',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry replays instead of refusing the allocation it revoked.
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'revoke_capability_limit_allocation'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability allocation revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_assignment_id, p_tenant_id, p_organization_id,
      receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  select assignment.* into target
  from vortex_access.capability_policy_assignments as assignment
  where assignment.assignment_id = p_assignment_id for update;
  -- The command names the subject it believes it is revoking, so it can never
  -- settle another scope's allocation, or a ceiling, by naming only its identifier.
  if not found or target.tenant_id <> p_tenant_id
    or target.organization_id is distinct from p_organization_id
    or target.assignment_kind <> 'allocation' then
    raise exception using errcode = 'V3101', message = 'Capability allocation is unavailable';
  end if;
  if target.revoked_at is not null or target.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Capability allocation is stale';
  end if;
  update vortex_access.capability_policy_assignments as assignment
  set revision = p_expected_revision + 1, changed_at = evaluated_at,
      changed_by_actor_id = actor_identity_id, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = actor_identity_id,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, actor_identity_id, p_tenant_id, 'revoke_capability_limit_allocation',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[(p_expected_revision + 1)::bigint], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, p_organization_id, 'allocation_revoked', 'tenant_administrator',
    actor_identity_id, target.policy_id, target.policy_revision, p_assignment_id,
    p_expected_revision + 1, target.capability_key, target.unit, null, null,
    vortex_context.channel(), request_correlation_id, evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, target.policy_id]) as subject(subject_id);
    activity_result := vortex_activity.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'identity', actor_identity_id,
      'revoke_capability_limit_allocation', activity_subjects, array[]::uuid[],
      vortex_context.channel(), request_correlation_id, 'completed'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Capability allocation revocation Activity is stale';
    end if;
  end if;
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_organization_id,
    p_expected_revision + 1, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Tenant capability-limits allocation permission command that revokes a tenant-wide or organisation allocation, leaving the platform ceiling as the bound; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';


create or replace function vortex_identity.grant_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_subject_identity_id uuid,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_context.is_non_nil_uuid(p_subject_identity_id::text)
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' or capabilities is null
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  perform 1 from vortex_identity.identity_projections projection
    where projection.identity_id in (actor_identity_id, p_subject_identity_id)
    order by projection.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments assignment
    where assignment.tenant_id = p_tenant_id and assignment.identity_id = actor_identity_id
    order by assignment.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant_tenant_administrator',
      p_tenant_id::text, p_subject_identity_id::text, pg_catalog.array_to_string(capabilities, ','),
      vortex_context.format_timestamp_utc(p_starts_at),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  if not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = p_subject_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'grant_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      receipt.subject_ids[1], receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  insert into vortex_identity.tenant_administrator_assignments values (
    new_assignment_id, p_tenant_id, p_subject_identity_id, capabilities, p_starts_at, p_expires_at, 1,
    evaluated_at, actor_identity_id, new_correlation_id, evaluated_at, actor_identity_id, new_correlation_id, null, null, null
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id, 'grant_tenant_administrator',
    p_duplicate_key, computed_fingerprint, array[new_assignment_id], array[1::bigint], evaluated_at
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry and accepted replay.';

create or replace function vortex_identity.change_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or capabilities is null or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select a.identity_id into target_identity_id
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id in (actor_identity_id, target_identity_id)
    order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a
    where a.tenant_id = p_tenant_id
      and (a.identity_id = actor_identity_id or a.assignment_id = p_assignment_id)
    order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id,
    'platform.tenant.administrators.manage', evaluated_at
  );
  if target_identity_id is null or not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = target_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if target_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'change_tenant_administrator',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text,
      pg_catalog.array_to_string(capabilities, ','),
      vortex_context.format_timestamp_utc(p_starts_at),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'change_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      p_assignment_id, receipt.subject_revisions[1], receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not (
      'platform.tenant.administrators.manage' = any(capabilities)
      and p_starts_at <= evaluated_at and p_expires_at is null
    ) and not vortex_identity.tenant_has_permanent_manager(
      p_tenant_id, evaluated_at, p_assignment_id
    ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set capability_keys = capabilities, starts_at = p_starts_at,
    expires_at = p_expires_at, revision = resulting_revision,
    changed_at = evaluated_at, changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'change_tenant_administrator', p_duplicate_key, computed_fingerprint,
    array[p_assignment_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';
