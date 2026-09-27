create or replace function vortex_access.set_capability_policy_ceiling(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_expected_revision bigint
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, policy_id uuid, policy_revision bigint,
  capability_key text, unit text, quantity_limit numeric, revision bigint,
  correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  policy vortex_access.capability_policy_definitions%rowtype;
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990) then
    raise exception using errcode = '22023', message = 'Capability ceiling is invalid';
  end if;
  -- Only the platform operator sets a tenant's ceiling.
  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'set_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_policy_id::text, p_policy_revision::text,
      p_starts_at::text, coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'set_capability_policy_ceiling'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability ceiling duplicate conflicts';
    end if;
    select stored.* into evidence
    from vortex_access.capability_limit_changes as stored
    where stored.change_id = receipt.receipt_id;
    if not found then
      raise exception using errcode = '42501', message = 'Capability ceiling replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.policy_id, evidence.policy_revision, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.assignment_revision, receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  select definition.* into policy
  from vortex_access.capability_policy_definitions as definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id
    and definition.revision = p_policy_revision;
  if not found then
    raise exception using errcode = 'V3101',
      message = 'Capability policy definition revision is unavailable';
  end if;
  if p_expected_revision is null then
    if exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.assignment_kind = 'ceiling'
        and assignment.capability_key = policy.capability_key
        and assignment.unit = policy.unit and assignment.revoked_at is null
    ) or exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.assignment_id = p_assignment_id
    ) then
      raise exception using errcode = '23505', message = 'Capability ceiling already exists';
    end if;
    resulting_revision := 1;
    insert into vortex_access.capability_policy_assignments(
      assignment_id, tenant_id, organization_id, policy_id, policy_revision,
      capability_key, unit, starts_at, expires_at, revision, assigned_at,
      assigned_by_actor_id, assignment_correlation_id, changed_at,
      changed_by_actor_id, change_correlation_id, assignment_kind, allocated_quantity
    ) values (
      p_assignment_id, p_tenant_id, null, p_policy_id, p_policy_revision,
      policy.capability_key, policy.unit, p_starts_at, p_expires_at, resulting_revision,
      evaluated_at, p_operator_actor_id, correlation, evaluated_at, p_operator_actor_id,
      correlation, 'ceiling', null
    );
  else
    select assignment.* into target
    from vortex_access.capability_policy_assignments as assignment
    where assignment.assignment_id = p_assignment_id for update;
    if not found or target.tenant_id <> p_tenant_id or target.assignment_kind <> 'ceiling' then
      raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
    end if;
    -- A ceiling is re-pinned in place so the tenant is never left without one,
    -- and only to a policy for the same capability and unit.
    if target.capability_key <> policy.capability_key or target.unit <> policy.unit then
      raise exception using errcode = '22023',
        message = 'Capability ceiling scope cannot change';
    end if;
    if target.revoked_at is not null or target.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Capability ceiling is stale';
    end if;
    resulting_revision := p_expected_revision + 1;
    update vortex_access.capability_policy_assignments as assignment
    set policy_id = p_policy_id, policy_revision = p_policy_revision,
        starts_at = p_starts_at, expires_at = p_expires_at, revision = resulting_revision,
        changed_at = evaluated_at, changed_by_actor_id = p_operator_actor_id,
        change_correlation_id = correlation
    where assignment.assignment_id = p_assignment_id;
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, p_operator_actor_id, p_tenant_id, 'set_capability_policy_ceiling',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[resulting_revision], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null,
    case when resulting_revision = 1 then 'ceiling_set' else 'ceiling_revised' end,
    'platform_operator', p_operator_actor_id, p_policy_id, p_policy_revision,
    p_assignment_id, resulting_revision, policy.capability_key, policy.unit,
    policy.quantity_limit, p_expires_at, 'system', correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_policy_id,
    p_policy_revision, policy.capability_key, policy.unit, policy.quantity_limit,
    resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) to vortex_runtime;

comment on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) is
  'Platform-operator-only command that sets, or re-pins in place, a tenant''s ceiling for one capability to an exact policy revision, with an accepted receipt and append-only change evidence.';
