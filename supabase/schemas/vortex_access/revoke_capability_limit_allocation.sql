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
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
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
  'Tenant-administrator command that revokes a tenant-wide or organisation allocation, leaving the platform ceiling as the bound; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';
