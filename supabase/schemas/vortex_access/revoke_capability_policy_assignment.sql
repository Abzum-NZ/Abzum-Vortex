create or replace function vortex_access.revoke_capability_policy_assignment(
  p_actor_identity_id uuid, p_actor_organization_account_id uuid,
  p_duplicate_key uuid, p_tenant_id uuid, p_organization_id uuid,
  p_assignment_id uuid, p_expected_revision bigint, p_activity_id uuid
)
returns table (outcome text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  target vortex_access.capability_policy_assignments%rowtype;
  established jsonb;
  decision record;
  acting_actor_id uuid := p_actor_identity_id;
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
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_context.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability policy revocation is invalid';
  end if;
  select assignment.* into target
  from vortex_access.capability_policy_assignments assignment
  where assignment.assignment_id = p_assignment_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy assignment is unavailable';
  end if;
  -- The command names the subject it believes it is revoking, so a tenant
  -- administrator can never settle an organisation assignment, or the reverse,
  -- by naming only its identifier.
  if target.tenant_id <> p_tenant_id
    or target.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Capability policy assignment scope is unavailable';
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
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_policy_assignment',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry of an accepted revocation replays its receipt instead of
  -- refusing the assignment it already revoked as stale.
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = acting_actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'revoke_capability_policy_assignment'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability policy revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_assignment_id, receipt.subject_revisions[1],
      receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  if target.revoked_at is not null or target.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Capability policy assignment is stale';
  end if;
  update vortex_access.capability_policy_assignments assignment
  set revision = p_expected_revision + 1, changed_at = evaluated_at,
      changed_by_actor_id = acting_actor_id, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = acting_actor_id,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, acting_actor_id, p_tenant_id, 'revoke_capability_policy_assignment',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[(p_expected_revision + 1)::bigint], evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, target.policy_id]) as subject(subject_id);
    activity_result := vortex_activity.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'organization_account', acting_actor_id,
      'revoke_capability_policy', activity_subjects, array[]::uuid[], vortex_context.channel(),
      (established ->> 'correlationId')::uuid, 'completed'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Capability policy revocation Activity is stale';
    end if;
  end if;
  return query select 'accepted'::text, p_assignment_id, p_expected_revision + 1,
    correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.revoke_capability_policy_assignment(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.revoke_capability_policy_assignment(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_capability_policy_assignment(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Protected capability-policy revocation command: establishes administrator authority from the request context, revokes the assignment and its accepted receipt, and records content-free Activity for an organisation scope.';
