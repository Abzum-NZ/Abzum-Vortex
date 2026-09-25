-- #1095: Record, lifecycle, capability, flow-binding, record-share and
-- installation-lifecycle operations record the calling channel from the trusted
-- request context instead of a literal web default or a caller-supplied
-- p_activity_source. Every replaced wrapper reads vortex_context.channel(), the
-- one accessor for the channel the trusted entry point installed (web when it
-- set none). The four private record-share writers lose their caller-supplied
-- p_activity_source parameter and per-wrapper not-in list entirely, so no caller
-- can name the recorded channel; their invocation rights are unchanged.
-- Signatures elsewhere, ownership, comments, security and search_path are
-- preserved. Access administration wrappers are #1094.

drop function vortex_access.grant_organization_direct_record_share(uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text, uuid, uuid, text, uuid);
drop function vortex_access.revoke_organization_direct_record_share(uuid, uuid, bigint, text, uuid, uuid, text, uuid);
drop function vortex_access.grant_record_share_for_administration(uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text, text, uuid, jsonb);
drop function vortex_access.revoke_record_share_for_administration(uuid, bigint, text, text, uuid);

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

create or replace function vortex_access.register_flow_execution_binding(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_node_id uuid,
  p_operation_owner_kind text,
  p_operation_owner_id uuid,
  p_operation_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid,
  p_permitted_invokers jsonb,
  p_permitted_surfaces jsonb,
  p_permitted_inputs jsonb,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  current_binding vortex_access.flow_execution_bindings%rowtype;
  stored_binding vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
  permits_system boolean;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_context.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null
    or p_operation_owner_kind not in ('application', 'module', 'platform_service')
    or p_operation_owner_id is null or not vortex_context.is_non_nil_uuid(p_operation_owner_id::text)
    or (p_operation_owner_kind = 'application' and p_operation_owner_id <> p_application_root_id)
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null))
    or p_permitted_invokers is null or pg_catalog.jsonb_typeof(p_permitted_invokers) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_invokers) not between 1 and 20
    or p_permitted_surfaces is null or pg_catalog.jsonb_typeof(p_permitted_surfaces) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_surfaces) not between 1 and 5
    or p_permitted_inputs is null or pg_catalog.jsonb_typeof(p_permitted_inputs) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_inputs) > 20
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow execution binding command is invalid';
  end if;

  -- Exact invoker, surface and input bounds: known shapes only, no duplicates.
  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
      where pg_catalog.jsonb_typeof(invoker.value) <> 'object'
        or not (
          (invoker.value = '{"kind":"system"}'::jsonb)
          or (
            invoker.value ->> 'kind' = 'organization_account'
            and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(invoker.value)) = 2
            and pg_catalog.jsonb_typeof(invoker.value -> 'organizationAccountId') = 'string'
            and vortex_context.is_non_nil_uuid(invoker.value ->> 'organizationAccountId')
          )
        )
    )
    or (
      select pg_catalog.count(distinct case invoker.value ->> 'kind'
        when 'system' then 'system'
        else 'account:' || pg_catalog.lower(invoker.value ->> 'organizationAccountId')
      end)
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_invokers)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_surfaces) as surface(value)
      where pg_catalog.jsonb_typeof(surface.value) <> 'string'
        or surface.value #>> '{}' not in (
          'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
          'durable_workflow', 'system')
    )
    or (
      select pg_catalog.count(distinct surface.value)
      from pg_catalog.jsonb_array_elements(p_permitted_surfaces) as surface(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_surfaces)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_inputs) as input(value)
      where pg_catalog.jsonb_typeof(input.value) <> 'string'
        or pg_catalog.char_length(input.value #>> '{}') not between 1 and 40
        or (input.value #>> '{}') !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    )
    or (
      select pg_catalog.count(distinct input.value)
      from pg_catalog.jsonb_array_elements(p_permitted_inputs) as input(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_inputs) then
    raise exception using errcode = '22023', message = 'Flow execution binding bounds are invalid';
  end if;

  permits_system := p_permitted_invokers @> '[{"kind":"system"}]'::jsonb;
  if (p_actor_kind = 'system') <> permits_system then
    raise exception using errcode = '22023',
      message = 'Only a system execution binding permits, and must permit, the system origin';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'grant'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'register_flow_execution_binding',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_application_root_id::text,
      p_release_version,
      p_flow_id::text,
      p_node_id::text,
      p_operation_owner_kind,
      p_operation_owner_id::text,
      p_operation_id::text,
      p_actor_kind,
      coalesce(p_actor_account_id::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      p_permitted_invokers::text,
      p_permitted_surfaces::text,
      p_permitted_inputs::text,
      coalesce(vortex_access.flow_execution_binding_timestamp_internal(p_expires_at), ''),
      coalesce(p_expected_revision::text, '')
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'register_flow_execution_binding'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_execution_binding_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow execution binding duplicate conflicts';
    end if;
    select binding.* into stored_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = receipt.subject_revisions[1]
      and binding.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow execution binding replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json_internal(stored_binding),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  -- The effective person and every named invoker must be active accounts of
  -- this organisation now; #686 re-checks their lifecycle at each use.
  if p_actor_kind = 'specified_user' and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_actor_account_id
        and account.organization_id = p_organization_id
        and account.state = 'active'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
      where invoker.value ->> 'kind' = 'organization_account'
        and not exists (
          select 1 from vortex_identity.organization_accounts as account
          where account.organization_account_id = (invoker.value ->> 'organizationAccountId')::uuid
            and account.organization_id = p_organization_id
            and account.state = 'active'
        )
    ) then
    raise exception using errcode = '42501', message = 'Flow execution binding account is unavailable';
  end if;

  select binding.* into current_binding
  from vortex_access.flow_execution_bindings as binding
  where binding.execution_binding_id = p_execution_binding_id
    and binding.is_current
  for update;

  if found then
    if current_binding.organization_id is distinct from p_organization_id then
      raise exception using errcode = '23505', message = 'Flow execution binding identity is unavailable';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = '23505', message = 'Flow execution binding already exists';
    end if;
    if current_binding.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'A revoked flow execution binding cannot be revived';
    end if;
    if current_binding.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
    end if;
    if current_binding.application_root_id is distinct from p_application_root_id
      or current_binding.release_version is distinct from p_release_version
      or current_binding.flow_id is distinct from p_flow_id
      or current_binding.node_id is distinct from p_node_id
      or current_binding.operation_owner_kind is distinct from p_operation_owner_kind
      or current_binding.operation_owner_id is distinct from p_operation_owner_id
      or current_binding.operation_id is distinct from p_operation_id
      or current_binding.actor_kind is distinct from p_actor_kind
      or current_binding.actor_organization_account_id is distinct from p_actor_account_id
      or current_binding.actor_system_actor_id is distinct from p_actor_system_actor_id then
      raise exception using errcode = '22023', message = 'Flow execution binding scope is immutable';
    end if;
    next_revision := current_binding.revision + 1;
  else
    if p_expected_revision is not null then
      raise exception using errcode = 'V3102', message = 'Flow execution binding is unavailable';
    end if;
    next_revision := 1;
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow execution binding expiry must be in the future';
  end if;

  if next_revision > 1 then
    update vortex_access.flow_execution_bindings as binding
    set is_current = false
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = current_binding.revision;
  end if;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version,
    p_flow_id, p_node_id, p_operation_owner_kind, p_operation_owner_id, p_operation_id,
    p_actor_kind, p_actor_account_id, p_actor_system_actor_id,
    p_permitted_invokers, p_permitted_surfaces, p_permitted_inputs,
    p_expires_at, 'active', operation_at, p_actor_organization_account_id, authority.correlation_id, null
  ) returning * into stored_binding;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    case when next_revision = 1
      then 'register_flow_execution_binding'
      else 'replace_flow_execution_binding'
    end,
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow execution binding Activity is stale';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    receipt_id, p_actor_organization_account_id, authority.tenant_id,
    'register_flow_execution_binding', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json_internal(stored_binding),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) is
  'Registers or replaces one exact flow execution binding at its next revision; permitted surfaces are drawn from the one channel vocabulary.';

create or replace function vortex_access.revoke_flow_execution_binding(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  current_binding vortex_access.flow_execution_bindings%rowtype;
  stored_binding vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow execution binding revoke command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'revoke'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'revoke_flow_execution_binding',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_expected_revision::text
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'revoke_flow_execution_binding'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_execution_binding_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow execution binding duplicate conflicts';
    end if;
    select binding.* into stored_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = receipt.subject_revisions[1]
      and binding.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow execution binding replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json_internal(stored_binding),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  -- A binding of another organisation is indistinguishable from a missing one.
  select binding.* into current_binding
  from vortex_access.flow_execution_bindings as binding
  where binding.execution_binding_id = p_execution_binding_id
    and binding.organization_id = p_organization_id
    and binding.is_current
  for update;

  if not found or current_binding.state = 'revoked' then
    raise exception using errcode = 'V3101', message = 'Flow execution binding is unavailable';
  end if;
  if current_binding.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  next_revision := current_binding.revision + 1;

  update vortex_access.flow_execution_bindings as binding
  set is_current = false
  where binding.execution_binding_id = p_execution_binding_id
    and binding.revision = current_binding.revision;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    current_binding.execution_binding_id, next_revision, true,
    current_binding.organization_id, current_binding.application_root_id,
    current_binding.release_version, current_binding.flow_id, current_binding.node_id,
    current_binding.operation_owner_kind, current_binding.operation_owner_id,
    current_binding.operation_id, current_binding.actor_kind,
    current_binding.actor_organization_account_id, current_binding.actor_system_actor_id,
    current_binding.permitted_invokers, current_binding.permitted_surfaces,
    current_binding.permitted_inputs, current_binding.expires_at, 'revoked', operation_at,
    p_actor_organization_account_id, authority.correlation_id, operation_at
  ) returning * into stored_binding;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_execution_binding',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow execution binding Activity is stale';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    receipt_id, p_actor_organization_account_id, authority.tenant_id,
    'revoke_flow_execution_binding', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json_internal(stored_binding),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow execution binding at its next revision; the recorded channel comes from the trusted request context.';

create or replace function vortex_module.append_application_installation_activity_internal(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_action text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in ('activate_application_installation', 'withdraw_application_installation') then
    raise exception using errcode = '22023',
      message = 'Application installation Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action,
    array[p_application_root_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Application installation Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) to vortex_module_owner;

comment on function vortex_module.append_application_installation_activity_internal(
  uuid, uuid, text
) is
  'Private content-free Activity composer for one protected Application installation lifecycle change.';

create or replace function vortex_access.change_application_installation_access(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_change text,
  p_prepared_templates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  current_registration vortex_access.permission_registrations%rowtype;
  registration_found boolean;
  coordinated_operation text;
  expected_revision bigint;
  changed record;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change is null
    or p_change not in ('prepare', 'withdraw')
    or (p_change = 'prepare' and p_prepared_templates is null)
    or (p_change = 'withdraw' and p_prepared_templates is not null) then
    raise exception using errcode = '22023',
      message = 'Application installation access command is invalid';
  end if;

  -- Locks the organisation Access version and proves current installation
  -- authority. Every registration writer takes that lock first, so the
  -- registration read below cannot change before the coordinator rechecks it.
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = authority.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  registration_found := found;

  if p_change = 'withdraw' then
    if not registration_found then
      raise exception using errcode = 'P0002',
        message = 'Application permission registration is unavailable';
    end if;
    if current_registration.state = 'withdrawn' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unchanged',
        'operation', 'withdraw',
        'organizationId', authority.organization_id,
        'applicationRootId', p_application_root_id,
        'registrationState', current_registration.state,
        'registrationRevision', current_registration.revision
      );
    end if;
    coordinated_operation := 'withdraw';
    expected_revision := current_registration.revision;
  elsif not registration_found then
    coordinated_operation := 'register';
    expected_revision := null;
  elsif current_registration.state = 'withdrawn' then
    coordinated_operation := 'reactivate';
    expected_revision := current_registration.revision;
  else
    coordinated_operation := 'update';
    expected_revision := current_registration.revision;
  end if;

  -- The coordinator validates the prepared candidate against the stored
  -- Application and Module releases and this organisation, applies continuity
  -- narrowing, never assigns a role, and asserts the permanent-steward
  -- invariant before it returns.
  select result.* into strict changed
  from vortex_access.coordinate_application_access_change(
    coordinated_operation,
    expected_revision,
    p_prepared_templates,
    authority.organization_id,
    p_application_root_id,
    authority.organization_account_id,
    authority.correlation_id
  ) as result;

  if changed.organization_id <> authority.organization_id
    or changed.application_root_id <> p_application_root_id
    or changed.correlation_id <> authority.correlation_id then
    raise exception using errcode = '55000',
      message = 'Application installation access result is inconsistent';
  end if;

  if changed.outcome = 'changed' then
    append_result := vortex_activity.append_organization_activity_entry(
      authority.organization_id,
      p_activity_id,
      pg_catalog.statement_timestamp(),
      'organization_account',
      authority.organization_account_id,
      coordinated_operation || '_application_access',
      array[p_application_root_id]::uuid[],
      array[]::uuid[],
      vortex_context.channel(),
      authority.correlation_id,
      'completed'
    );
    if append_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Application installation access Activity is stale';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', changed.outcome,
    'operation', changed.operation,
    'organizationId', changed.organization_id,
    'applicationRootId', changed.application_root_id,
    'registrationState', changed.registration_state,
    'registrationRevision', changed.registration_revision
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation access evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation access evidence is ambiguous';
end
$function$;

revoke all on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) to vortex_request;

comment on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) is
  'Authority-checked Application permission registration change for installation; derives actor and correlation from validated human context and grants no access.';

create or replace function vortex_record.append_base_save_activity_internal(
  p_activity_id uuid,
  p_operation text,
  p_subject_id uuid,
  p_changed_field_ids uuid[],
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    )
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023',
      message = 'Record save Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save Activity requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    case when p_operation = 'create' then 'create_record' else 'update_record' end,
    array[p_subject_id]::uuid[], p_changed_field_ids, vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record save Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_base_save_activity_internal(
  uuid, text, uuid, uuid[], text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_base_save_activity_internal(
  uuid, text, uuid, uuid[], text
) to vortex_record_adapter;

comment on function vortex_record.append_base_save_activity_internal(
  uuid, text, uuid, uuid[], text
) is
  'Private Record save Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';

create or replace function vortex_record.append_named_action_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
  p_changed_field_ids uuid[],
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) canonical
    )
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Named action Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, p_activity_id,
    occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'execute_named_action', array[p_subject_id]::uuid[], p_changed_field_ids,
    vortex_context.channel(), (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Named action Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text)
to vortex_record_adapter;

comment on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text) is
  'Private named-action Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';

create or replace function vortex_record.append_ownership_transfer_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record ownership transfer Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'transfer_record_ownership', array[p_subject_id]::uuid[], array[]::uuid[],
    vortex_context.channel(), (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record ownership transfer Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  to vortex_record_adapter;

comment on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text) is
  'Private Record ownership-transfer Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';

create or replace function vortex_record.append_record_lifecycle_activity_internal(
  p_activity_id uuid,
  p_operation text,
  p_subject_ids uuid[]
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation is null
    or p_operation not in ('delete', 'restore')
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    ) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record lifecycle Activity requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    case p_operation when 'delete' then 'delete_record' else 'restore_record' end,
    p_subject_ids, array[]::uuid[], vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record lifecycle Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) to vortex_record_adapter;

comment on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) is
  'Private Record delete and restore Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';

create or replace function vortex_record.append_lifecycle_policy_activity_internal(
  p_activity_id uuid,
  p_policy_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_policy_id is null
    or p_policy_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record lifecycle policy Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'manage_record_lifecycle_policy',
    array[p_policy_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  to vortex_record_owner;

comment on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid) is
  'Private Record lifecycle-policy Activity composer: derives the organisation, account and correlation from the validated request context and records the channel from that context.';

create or replace function vortex_access.grant_organization_direct_record_share(
  p_organization_id uuid,
  p_direct_share_id uuid,
  p_storage_scope text,
  p_application_root_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_recipient_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_readable_field_ids uuid[],
  p_changeable_field_ids uuid[],
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_reason text,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_activity_id uuid
)
returns table (
  direct_share_id uuid,
  revision bigint,
  state text,
  changed_at timestamptz,
  access_version bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  operation_at timestamptz;
  next_access_version bigint;
  activity_result text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_module_root_id is null
    or not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_record_type_id is null
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or p_storage_contract_id is null
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_changed_by is null
    or not vortex_context.is_non_nil_uuid(p_changed_by::text)
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or (p_storage_scope = 'organization_shared' and p_application_root_id is not null)
    or (p_storage_scope = 'application_contained' and (
      p_application_root_id is null
      or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    ))
    or p_recipient_kind not in ('organization_account', 'group')
    or (p_recipient_kind = 'organization_account' and (
      p_organization_account_id is null
      or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
      or p_group_id is not null
    ))
    or (p_recipient_kind = 'group' and (
      p_group_id is null
      or not vortex_context.is_non_nil_uuid(p_group_id::text)
      or p_organization_account_id is not null
    ))
    or p_readable_field_ids is null
    or pg_catalog.cardinality(p_readable_field_ids) = 0
    or not vortex_access.direct_share_field_ids_are_canonical(p_readable_field_ids)
    or p_changeable_field_ids is null
    or not vortex_access.direct_share_field_ids_are_canonical(p_changeable_field_ids)
    or not (p_changeable_field_ids <@ p_readable_field_ids)
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023',
      message = 'Direct record-share grant input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Direct record-share grant scope is unavailable';
  end if;

  if p_recipient_kind = 'organization_account' then
    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active';
  else
    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.state = 'active';
  end if;
  if not found then
    raise exception using errcode = '42501',
      message = 'Direct record-share recipient is unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_direct_record_shares as share
    where share.organization_id = p_organization_id
      and share.direct_share_id = p_direct_share_id
  ) then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant is stale or unavailable';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant window is stale';
  end if;
  insert into vortex_access.organization_direct_record_shares (
    organization_id, direct_share_id, storage_scope, application_root_id,
    module_root_id, record_type_id, storage_contract_id, record_id,
    recipient_kind, organization_account_id, group_id, readable_field_ids,
    changeable_field_ids, starts_at, expires_at, state, revision, granted_by,
    granted_at, grant_correlation_id, reason, changed_at
  ) values (
    p_organization_id, p_direct_share_id, p_storage_scope,
    p_application_root_id, p_module_root_id, p_record_type_id,
    p_storage_contract_id, p_record_id, p_recipient_kind,
    p_organization_account_id, p_group_id, p_readable_field_ids,
    p_changeable_field_ids, p_starts_at, p_expires_at, 'active', 1,
    p_changed_by, operation_at, p_correlation_id, p_reason, operation_at
  );

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'direct_share_changed'
  ) as version;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, operation_at, 'organization_account',
    p_changed_by, 'grant_direct_record_share', array[p_direct_share_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Direct record-share grant Activity is stale';
  end if;

  return query select p_direct_share_id, 1::bigint, 'active'::text,
    operation_at, next_access_version;
end
$function$;

revoke execute on function vortex_access.grant_organization_direct_record_share(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[],
  uuid[], timestamptz, timestamptz, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.grant_organization_direct_record_share(
  uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, uuid[],
  uuid[], timestamptz, timestamptz, text, uuid, uuid, uuid
) is
  'Owner-only structural direct-share grant writer. It changes Access and appends Activity but makes no grantor authorization or field-ceiling decision.';

create or replace function vortex_access.revoke_organization_direct_record_share(
  p_organization_id uuid,
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_activity_id uuid
)
returns table (
  direct_share_id uuid,
  revision bigint,
  state text,
  changed_at timestamptz,
  access_version bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  current_share vortex_access.organization_direct_record_shares%rowtype;
  operation_at timestamptz;
  next_access_version bigint;
  activity_result text;
begin
  if p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_changed_by is null
    or not vortex_context.is_non_nil_uuid(p_changed_by::text)
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023',
      message = 'Direct record-share revocation input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Direct record-share revocation scope is unavailable';
  end if;

  select share.* into current_share
  from vortex_access.organization_direct_record_shares as share
  where share.organization_id = p_organization_id
    and share.direct_share_id = p_direct_share_id
  for update;
  if not found
    or current_share.state <> 'active'
    or current_share.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation is stale or unavailable';
  end if;
  if current_share.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Direct record-share revision is exhausted';
  end if;

  operation_at := greatest(current_share.changed_at, pg_catalog.clock_timestamp());
  update vortex_access.organization_direct_record_shares as share
  set state = 'revoked', revision = current_share.revision + 1,
      revoked_by = p_changed_by, revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id,
      revocation_reason = p_reason, changed_at = operation_at
  where share.organization_id = p_organization_id
    and share.direct_share_id = p_direct_share_id
    and share.state = 'active'
    and share.revision = p_expected_revision;
  if not found then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation is stale or unavailable';
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id, 'direct_share_changed'
  ) as version;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, operation_at, 'organization_account',
    p_changed_by, 'revoke_direct_record_share', array[p_direct_share_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), p_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Direct record-share revocation Activity is stale';
  end if;

  return query select p_direct_share_id, current_share.revision + 1,
    'revoked'::text, operation_at, next_access_version;
end
$function$;

revoke execute on function vortex_access.revoke_organization_direct_record_share(
  uuid, uuid, bigint, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.revoke_organization_direct_record_share(
  uuid, uuid, bigint, text, uuid, uuid, uuid
) is
  'Owner-only terminal direct-share revocation writer. It changes Access and appends Activity but grants no caller authority.';

create or replace function vortex_access.grant_record_share_for_administration(
  p_direct_share_id uuid,
  p_record_id uuid,
  p_recipient_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_readable_field_ids uuid[],
  p_changeable_field_ids uuid[],
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_reason text,
  p_activity_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  facts_binding jsonb;
  -- Prefixed target_* deliberately: an unqualified module_root_id/record_
  -- type_id/storage_contract_id/storage_scope here would be ambiguous
  -- against the identically named columns the queries below select from --
  -- PL/pgSQL raises a hard error for that, not a silent wrong guess.
  target_module_root_id uuid;
  target_record_type_id uuid;
  target_storage_contract_id uuid;
  target_storage_scope text;
  needed record;
  required_permissions jsonb;
  declaration jsonb;
  decision jsonb;
  bounds jsonb;
  read_admitted boolean := false;
  readable_ceiling uuid[] := array[]::uuid[];
  changeable_ceiling uuid[] := array[]::uuid[];
  granted record;
  grantor_authority_until timestamptz;
  earliest_authority_until timestamptz;
begin
  if p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_record_id is null
    or not vortex_context.is_non_nil_uuid(p_record_id::text)
    or p_recipient_kind is null
    or p_recipient_kind not in ('organization_account', 'group')
    or (p_recipient_kind = 'organization_account' and (
      p_organization_account_id is null
      or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
      or p_group_id is not null
    ))
    or (p_recipient_kind = 'group' and (
      p_group_id is null
      or not vortex_context.is_non_nil_uuid(p_group_id::text)
      or p_organization_account_id is not null
    ))
    or p_readable_field_ids is null
    or pg_catalog.cardinality(p_readable_field_ids) = 0
    or not vortex_access.direct_share_field_ids_are_canonical(p_readable_field_ids)
    or p_changeable_field_ids is null
    or not vortex_access.direct_share_field_ids_are_canonical(p_changeable_field_ids)
    or not (p_changeable_field_ids <@ p_readable_field_ids)
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_facts is null
    or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object' then
    raise exception using errcode = '22023',
      message = 'Protected record-share grant input is invalid';
  end if;

  -- Step 1: validate the request context and the recipient. The recipient
  -- must be a current organisation account or Group in the caller's own
  -- (same) organisation; a foreign or unknown recipient refuses here, before
  -- any lock or authority evaluation.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant requires an application context';
  end if;

  if p_recipient_kind = 'organization_account' then
    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = context_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active';
  else
    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = context_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.state = 'active';
  end if;
  if not found then
    raise exception using errcode = '42501',
      message = 'Protected record-share recipient is unavailable';
  end if;
  if p_recipient_kind = 'organization_account'
    and p_organization_account_id = context_account_id then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant cannot target the grantor''s own account';
  end if;

  -- Step 2: acquire the existing governance/change lock before evaluating
  -- any authority. Never take a read lock and upgrade it later -- that
  -- upgrade is the exact race this ordering prevents: it would let a
  -- concurrent change to the grantor's own authority land between an
  -- unlocked check and the eventual write.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant is unavailable';
  end if;

  -- The binding this grant concerns comes from the caller's own trusted
  -- facts -- the adapter's real, resolved projection of the target record --
  -- never from a caller-supplied scalar naming the same module, record
  -- type, storage contract or storage scope a second, unchecked way. The
  -- decision below independently cross-checks this same binding against
  -- both the declaration it builds and the target row inside p_facts
  -- itself, so a facts payload that disagrees with the record it claims to
  -- describe refuses there, before anything is admitted.
  facts_binding := p_facts -> 'binding';
  target_module_root_id := (facts_binding ->> 'moduleRootId')::uuid;
  target_record_type_id := (facts_binding ->> 'recordTypeId')::uuid;
  target_storage_contract_id := (facts_binding ->> 'storageContractId')::uuid;
  target_storage_scope := facts_binding ->> 'storageScope';

  -- Steps 3 and 5: the grantor's current record decision, evaluated fresh
  -- under the lock just acquired. Read is always evaluated (a share must
  -- name at least one readable field); update is evaluated only when
  -- changeable fields are actually proposed, so a grantor with read but no
  -- update authority is never wrongly required to hold update authority
  -- they do not need. Facts are the adapter's real projection of the target
  -- record and its relationship/condition graph, shared unchanged between
  -- every decision below.
  for needed in
    select 1 as step, 'share' as action_kind, 'record.share' as operation_key
    union all
    select 2, 'read', 'record.share.read'
    union all
    select 3, 'update', 'record.share.update'
    where pg_catalog.cardinality(p_changeable_field_ids) > 0
    order by step
  loop
    -- required_permissions carries every *current* entry of this exact
    -- action kind on the exact target record type -- ownership,
    -- direct_share, relationship and condition-scoped alike (F3): none is
    -- excluded any more, because the facts backing evaluation are now the
    -- adapter's real projection of the record, not an empty stand-in that
    -- would make a relationship or condition route hard-fail instead of
    -- gracefully refuse.
    select
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind, 'ownerId', entry.owner_id,
          'permissionId', entry.permission_id
        )
        order by entry.owner_kind, entry.owner_id, entry.permission_id
      )
    into required_permissions
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = context_organization_id
      and entry.application_root_id = context_application_root_id
      and entry.owner_kind in ('application', 'module')
      and (
        (entry.owner_kind = 'application' and entry.owner_id = context_application_root_id)
        or (entry.owner_kind = 'module' and entry.owner_id = target_module_root_id)
      )
      and entry.record_type_id = target_record_type_id
      and entry.action_kind = needed.action_kind
      and entry.record_scope is not null;

    -- No current candidate permission at all for this action kind: leave it
    -- unadmitted below rather than calling the decision engine with an empty
    -- requiredPermissions array, which it treats as a malformed declaration,
    -- not a graceful refusal. For share (N3/N4), this is the genuine "no
    -- permission at all" cause, so it raises right here, while that is still
    -- the known reason -- the alternative, waiting until after the loop,
    -- would have nothing left to say why, because a later iteration's own
    -- query overwrites required_permissions before the loop ends.
    if required_permissions is null then
      if needed.action_kind = 'share' then
        raise exception using errcode = '42501',
          message = 'Protected record-share grant requires a current share permission';
      end if;
      continue;
    end if;

    declaration := pg_catalog.jsonb_build_object(
      'operationKey', needed.operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', needed.action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', facts_binding,
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    );

    decision := vortex_access.evaluate_organization_record_access_internal(
      declaration, p_record_id, p_facts
    );
    -- How long this admitted authority lasts, beyond the session; null
    -- does not expire and so does not lower the bound.
    if decision ->> 'outcome' = 'allowed' then
      grantor_authority_until := vortex_access.record_share_grantor_authority_until_internal(
        declaration, p_record_id, p_facts, context_value
      );
      earliest_authority_until := least(earliest_authority_until, grantor_authority_until);
    end if;

    if needed.action_kind = 'share' then
      -- Step 3b (F1): the grantor must currently hold record.share for this
      -- exact record type, over this exact record. Checked first -- before
      -- any ceiling comparison and before any mutation -- by raising here,
      -- inline, while this decision is still the fresh one (the next
      -- iteration, evaluating read, would overwrite it). A share-permission
      -- candidate existed (required_permissions was not null, above); when
      -- this decision still did not admit it, `reasonCode` says which of two
      -- real causes it was (N3/N4), already computed by the decision itself
      -- rather than new state added here: `record_scope_refused` is a
      -- target the grantor's share authority cannot currently reach -- a
      -- nonexistent or soft-deleted record, an organisation/application
      -- mismatch, or a record no held route (ownership, an existing direct
      -- share, a relationship edge, a saved condition) actually connects
      -- them to -- distinct from every other reason, which is never holding
      -- an effective share permission at all (stale eligibility, an
      -- unsupported delegated/support context, or recent-authentication
      -- unsatisfied -- none reachable from this migration's own fixed
      -- declaration today, but named correctly regardless). F3 (slice 7):
      -- the message previously said the target record was "unavailable",
      -- which a caller who does hold a real share permission could read as
      -- "no such record" specifically -- an existence oracle for exactly the
      -- callers this refusal exists to stop. `record_scope_refused` covers
      -- both a record that does not currently exist and one that does but
      -- matched no held route, and the wording below no longer distinguishes
      -- them, on purpose.
      if decision ->> 'outcome' <> 'allowed' then
        if decision ->> 'reasonCode' = 'record_scope_refused' then
          raise exception using errcode = '42501',
            message = 'Protected record-share grant target record is not within your current share authority';
        else
          raise exception using errcode = '42501',
            message = 'Protected record-share grant requires a current share permission';
        end if;
      end if;
    elsif needed.action_kind = 'read' then
      if decision ->> 'outcome' = 'allowed' then
        read_admitted := true;
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
        select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
        into readable_ceiling
        from pg_catalog.jsonb_array_elements_text(bounds -> 'readableFieldIds') as elem(value);
      end if;
    else
      if decision ->> 'outcome' = 'allowed' then
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
        select coalesce(pg_catalog.array_agg((elem.value)::uuid), array[]::uuid[])
        into changeable_ceiling
        from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') as elem(value);
      end if;
    end if;
  end loop;

  -- Reaching here means the share iteration above admitted -- it always
  -- raises otherwise, and it always runs first (order by step).

  -- Step 4: the proposed readable fields must be a subset of the grantor's
  -- current readable set. A share must include at least one readable field,
  -- matching the existing writer's own requirement. Split in two (N3/N4) so
  -- the message names its real cause: holding no current read authority
  -- that reaches this exact record at all, versus holding some but
  -- proposing beyond it. F4 (slice 7) adds a third: the read decision can be
  -- 'allowed' while every admitted contribution's own field policy is
  -- non-null but names no readable field at all (resolve_record_field_
  -- bounds_internal's own "a missing policy contributes no fields" rule
  -- means an *explicitly empty* one contributes none either) -- an empty
  -- ceiling is not exceeded by any non-empty proposal, so it is not the same
  -- cause as holding a non-empty ceiling too narrow for the proposal, and is
  -- named separately rather than folded into "exceeds".
  if not read_admitted then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant requires a current read permission';
  end if;
  if pg_catalog.cardinality(readable_ceiling) = 0 then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant currently holds no readable fields for this record';
  end if;
  if pg_catalog.cardinality(p_readable_field_ids) = 0
    or not (p_readable_field_ids <@ readable_ceiling) then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant exceeds current read authority';
  end if;

  -- Step 6: the proposed changeable fields must be a subset of both the
  -- grantor's current changeable set and the proposed readable fields.
  -- Skipped entirely when no changeable fields are proposed, matching the
  -- update decision above never having been evaluated in that case.
  if pg_catalog.cardinality(p_changeable_field_ids) > 0
    and (
      not (p_changeable_field_ids <@ changeable_ceiling)
      or not (p_changeable_field_ids <@ p_readable_field_ids)
    ) then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant exceeds current update authority';
  end if;

  -- Step 7: invoke the existing grant writer. It owns the revision check,
  -- Activity append and Access invalidation; nothing here duplicates them.
  -- Every identifier passed through is either the verified request
  -- context's own, or read from the trusted facts' own binding -- never a
  -- caller-supplied scalar the decision above did not already verify.
  -- The share never outlasts the earliest authority it was granted under.
  if earliest_authority_until is not null
    and (p_expires_at is null or p_expires_at > earliest_authority_until) then
    p_expires_at := earliest_authority_until;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant cannot outlast your own authority';
  end if;
  select result.* into strict granted
  from vortex_access.grant_organization_direct_record_share(
    context_organization_id, p_direct_share_id, target_storage_scope,
    case when target_storage_scope = 'application_contained' then context_application_root_id else null end,
    target_module_root_id, target_record_type_id, target_storage_contract_id, p_record_id,
    p_recipient_kind, p_organization_account_id, p_group_id,
    p_readable_field_ids, p_changeable_field_ids, p_starts_at, p_expires_at,
    p_reason, context_account_id, context_correlation_id,
    p_activity_id
  ) as result;

  return pg_catalog.jsonb_build_object(
    'directShareId', granted.direct_share_id,
    'revision', granted.revision,
    'state', granted.state,
    'changedAt', granted.changed_at,
    'accessVersion', granted.access_version
  );
end
$function$;

revoke execute on function vortex_access.grant_record_share_for_administration(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text,
  uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.grant_record_share_for_administration(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text,
  uuid, jsonb
) is
  'Protected same-organisation direct-share grant: locks governance before confirming the grantor currently holds record.share and re-deriving their own current read/update ceiling from the live catalogue evaluated over the caller''s trusted facts, requires the proposal to be a subset of that ceiling, then invokes the existing private writer. Owner-only; a fixed trusted adapter supplies p_facts (the target record''s real row, relationships and conditions) and holds the only request-role grant, exactly as #35''s own record decision.';

create or replace function vortex_access.revoke_record_share_for_administration(
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  current_share vortex_access.organization_direct_record_shares%rowtype;
  checked_at timestamptz;
  is_grantor boolean;
  declaration_binding jsonb;
  required_permissions jsonb;
  declaration jsonb;
  eligibility jsonb;
  revoked record;
begin
  if p_direct_share_id is null
    or not vortex_context.is_non_nil_uuid(p_direct_share_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null
    or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null
    or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023',
      message = 'Protected record-share revocation input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation requires an application context';
  end if;

  -- Same governance lock as the grant path, acquired before the authority
  -- check below, for the same reason: no read-then-upgrade race.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  select share.* into current_share
  from vortex_access.organization_direct_record_shares as share
  where share.organization_id = context_organization_id
    and share.direct_share_id = p_direct_share_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  -- F1 correction (slice 7). The share's own application must match the
  -- caller's current one -- unless the share is organisation_shared, which
  -- by definition crosses applications -- exactly as the complete record
  -- decision already requires the target row's own real recordScope.
  -- applicationRootId to match before it admits anything
  -- (20260910040755_compose_exact_record_access_decision.sql:816-819).
  -- Before this correction, nothing on this path ever compared the share's
  -- own stored application to the caller's: the declaration's target below
  -- and the catalogue filter it feeds are both built from
  -- context_application_root_id, so the eligibility core's own
  -- target-context check compared context against itself and always
  -- passed. An account acting in one application could therefore revoke a
  -- share belonging to another merely by holding record.share somewhere in
  -- its own.
  if current_share.storage_scope <> 'organization_shared'
    and current_share.application_root_id <> context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  checked_at := pg_catalog.clock_timestamp();

  -- Current authority over the share (F2 correction, slice 7): exactly two
  -- independent sufficient conditions, both re-derived fresh under the lock
  -- just acquired -- never the grantor's present read/update field ceiling
  -- (revocation is a narrowing act, unlike granting, so it needs neither),
  -- and -- unlike granting -- never the share's own target row: narrowing
  -- access never requires that the record being narrowed is currently
  -- visible. checked_at is this function's own one time sample, taken once
  -- under the lock, exactly as the complete decision takes its own one
  -- sample when the grant path calls it; context_value, sampled once above
  -- and already proven current against the freshly locked Access version,
  -- is reused rather than sampled a second time.
  --
  -- The first condition is being the account that granted this share.
  -- Identity is authority enough on its own -- a grantor can always
  -- withdraw what they gave, regardless of the record's lifecycle and
  -- regardless of whether they still hold any current permission at all --
  -- but a delegated or support context still cannot exercise it: "granted
  -- this share" names no permission the shared eligibility core can
  -- evaluate for context legitimacy, so the same unsupported-context test
  -- the core itself runs first for every other declaration is applied
  -- directly here for that one reason, not as a second evaluator.
  --
  -- The second, independent condition is holding a *current* record.share
  -- permission whose own catalogue record scope is decidable without the
  -- record row, which is exactly why revocation can outlive the record.
  -- A record scope is `{routes, savedCondition?}`, and both halves must be
  -- row-independent for the scope to be:
  --
  --   * Its routes must name all_records, the one route
  --     `evaluate_current_record_ownership_visibility` admits unconditionally
  --     once the binding matches, with no row-specific fact left to check
  --     (20260906144015_evaluate_current_record_ownership_visibility.sql).
  --     The contract already forces all_records to be the sole route when
  --     present, so naming it settles the whole array. Ownership,
  --     direct_share and relationship each require the row to mean anything.
  --
  --   * It must carry no saved condition. A saved condition narrows *every*
  --     route, all_records included -- `compose_exact_record_access_decision`
  --     says so in those words and evaluates it from the target row's own
  --     field values -- so a scope carrying one is row-dependent no matter
  --     how its routes read. Reasoning about the route in isolation was the
  --     hole an independent probe used: an account whose only share
  --     permission was all_records *narrowed by a condition* could not grant
  --     a share over a record the condition excluded, yet could revoke every
  --     existing share of that record type, including over records it can
  --     never reach.
  --
  -- Before either correction, every current share permission was accepted
  -- merely because its record_scope was not null, so an account whose only
  -- share permission was direct_share-routed -- which can never *create* a
  -- share -- could revoke every share of that record type.
  is_grantor := current_share.granted_by = context_account_id
    and not (context_value ? 'delegatedContext' or context_value ? 'supportContext');

  if not is_grantor then
    declaration_binding := pg_catalog.jsonb_build_object(
      'moduleRootId', current_share.module_root_id, 'recordTypeId', current_share.record_type_id,
      'storageContractId', current_share.storage_contract_id, 'storageScope', current_share.storage_scope
    );

    select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind, 'ownerId', entry.owner_id,
          'permissionId', entry.permission_id
        )
        order by entry.owner_kind, entry.owner_id, entry.permission_id
      )
    into required_permissions
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    where entry.organization_id = context_organization_id
      and entry.application_root_id = context_application_root_id
      and entry.owner_kind in ('application', 'module')
      and (
        (entry.owner_kind = 'application' and entry.owner_id = context_application_root_id)
        or (entry.owner_kind = 'module' and entry.owner_id = current_share.module_root_id)
      )
      and entry.record_type_id = current_share.record_type_id
      and entry.action_kind = 'share'
      and entry.record_scope is not null
      -- F2: only a record scope the eligibility core can resolve without the
      -- record row confers revoke authority -- see above. That is a property
      -- of the whole scope, not of its routes alone: a saved condition
      -- narrows every route, all_records included, so a scope carrying one
      -- is row-dependent however its routes read.
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(entry.record_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'all_records'
      )
      and not (entry.record_scope ? 'savedCondition');

    -- No current candidate row-independent share permission at all:
    -- leave eligibility unset rather than calling the eligibility core with
    -- an empty requiredPermissions array, exactly like the grant path.
    if required_permissions is not null then
      declaration := pg_catalog.jsonb_build_object(
        'operationKey', 'record.share',
        'action', pg_catalog.jsonb_build_object('actionKind', 'share'),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', context_application_root_id
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', declaration_binding,
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      );

      eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
        declaration, context_value, checked_at
      );
    end if;
  end if;

  if not is_grantor
    and (eligibility is null or eligibility ->> 'outcome' <> 'eligible') then
    raise exception using errcode = '42501',
      message = 'Protected record-share revocation is unavailable';
  end if;

  select result.* into strict revoked
  from vortex_access.revoke_organization_direct_record_share(
    context_organization_id, p_direct_share_id, p_expected_revision,
    p_reason, context_account_id, context_correlation_id,
    p_activity_id
  ) as result;

  return pg_catalog.jsonb_build_object(
    'directShareId', revoked.direct_share_id,
    'revision', revoked.revision,
    'state', revoked.state,
    'changedAt', revoked.changed_at,
    'accessVersion', revoked.access_version
  );
end
$function$;

revoke execute on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.revoke_record_share_for_administration(
  uuid, bigint, text, uuid
) is
  'Protected direct-share revocation: permitted only to an account currently acting in the share''s own application and organisation (organisation_shared shares excepted from the application match) that either is the share''s own non-delegated, non-support granted_by identity, or currently holds a record.share permission whose own catalogue record scope is decidable without the record row -- an all_records route and no saved condition, since a saved condition narrows every route including that one -- re-evaluated fresh under the governance lock, never the complete exact-record decision. Narrowing never requires the share''s own target record to be visible: never a re-requirement of the acting account''s present field ceiling, and never the record''s own existence or lifecycle state. Owner-only; reached only through a fixed adapter.';

create or replace function vortex_access.propose_record_share_grant_for_administration(
  p_grant_id uuid,
  p_consent_request_id uuid,
  p_terms jsonb,
  p_proposal_fingerprint text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object'
    or (p_consent_request_id is not null
      and p_consent_request_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal requires an application context';
  end if;

  -- Take the organisation governance lock before evaluating any authority, so a
  -- concurrent authority change cannot land between the check and the write.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant proposal is unavailable';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (p_consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  insert into vortex_access.record_share_grants (
    grant_id, source_organization_id, source_cluster_id, source_application_root_id,
    recipient_cluster_id, recipient_organization_id, recipient_application_root_id,
    scope_kind, module_root_id, record_type_id, record_id, saved_condition_id,
    saved_condition_revision, saved_condition_fingerprint, saved_condition_parameters,
    readable_field_ids, changeable_field_ids, recipient_role_ids, allowed_action_keys,
    export_allowed, approved_recipient_region, starts_at, expires_at, status,
    created_by_organization_account_id, consent_request_id, contract_version,
    contract_fingerprint, recipient_binding_id, definition_mapping_fingerprint,
    proposal_fingerprint, revision, created_at, changed_at
  ) values (
    p_grant_id, context_organization_id, (p_terms ->> 'sourceClusterId')::uuid,
    context_application_root_id, (p_terms ->> 'recipientClusterId')::uuid,
    (p_terms ->> 'recipientOrganizationId')::uuid,
    (p_terms ->> 'recipientApplicationRootId')::uuid,
    p_terms ->> 'scopeKind', (p_terms ->> 'moduleRootId')::uuid,
    (p_terms ->> 'recordTypeId')::uuid, (p_terms ->> 'recordId')::uuid,
    (p_terms ->> 'savedConditionId')::uuid, (p_terms ->> 'savedConditionRevision')::bigint,
    p_terms ->> 'savedConditionFingerprint', p_terms -> 'parameters',
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'readableFieldIds', 1, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'changeableFieldIds', 0, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'recipientRoleIds', 1, 100),
    array(select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
    (p_terms ->> 'exportAllowed')::boolean, p_terms ->> 'approvedRecipientRegion',
    (p_terms ->> 'startsAt')::timestamptz, (p_terms ->> 'expiresAt')::timestamptz,
    case when cross_organization then 'pending_consent' else 'draft' end,
    context_account_id, p_consent_request_id, p_terms ->> 'contractVersion',
    p_terms ->> 'contractFingerprint', (p_terms ->> 'recipientBindingId')::uuid,
    p_terms ->> 'definitionMappingFingerprint', p_proposal_fingerprint, 1,
    now_value, now_value
  );

  -- The grant's foreign key to its consent request is deferred, so the request
  -- follows the grant it names.
  if cross_organization then
    insert into vortex_access.record_share_grant_consent_requests (
      request_id, grant_id, source_organization_id, source_cluster_id,
      recipient_organization_id, recipient_cluster_id, proposed_grant_fingerprint,
      status, requested_by_organization_account_id, requested_at,
      source_authorizing_role_ids, recipient_accepting_role_ids, expires_at,
      revision, changed_at
    ) values (
      p_consent_request_id, p_grant_id, context_organization_id,
      (p_terms ->> 'sourceClusterId')::uuid,
      (p_terms ->> 'recipientOrganizationId')::uuid,
      (p_terms ->> 'recipientClusterId')::uuid, p_proposal_fingerprint,
      'pending', context_account_id, now_value,
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientAcceptingRoleIds', 1, 100),
      (p_terms ->> 'expiresAt')::timestamptz, 1, now_value
    );
  end if;


  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'propose_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant proposal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) to vortex_request;

comment on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) is
  'Fixed protected proposer: stores one exact record-share grant proposal for the context organisation after re-checking its current share authority; cross-organisation proposals stop at pending_consent with a consent request bound to the proposal fingerprint.';

create or replace function vortex_access.revise_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_terms jsonb,
  p_proposal_fingerprint text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  stored vortex_access.record_share_grants%rowtype;
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object' then
    raise exception using errcode = '22023',
      message = 'Record-share grant revision is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision requires an application context';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision is unavailable';
  end if;

  -- Only the source organisation's own application may revise its proposal; a
  -- foreign or unknown grant is indistinguishable from a missing one.
  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant revision is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  -- A revision cannot turn a same-organisation proposal into a cross-organisation
  -- one or back: consent is bound to the grant's recipient organisation.
  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (stored.consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant revision is invalid';
  end if;

  update vortex_access.record_share_grants as grants
  set source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
      recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
      recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
      recipient_application_root_id = (p_terms ->> 'recipientApplicationRootId')::uuid,
      scope_kind = p_terms ->> 'scopeKind',
      module_root_id = (p_terms ->> 'moduleRootId')::uuid,
      record_type_id = (p_terms ->> 'recordTypeId')::uuid,
      record_id = (p_terms ->> 'recordId')::uuid,
      saved_condition_id = (p_terms ->> 'savedConditionId')::uuid,
      saved_condition_revision = (p_terms ->> 'savedConditionRevision')::bigint,
      saved_condition_fingerprint = p_terms ->> 'savedConditionFingerprint',
      saved_condition_parameters = p_terms -> 'parameters',
      readable_field_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'readableFieldIds', 1, 500),
      changeable_field_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'changeableFieldIds', 0, 500),
      recipient_role_ids = vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientRoleIds', 1, 100),
      allowed_action_keys = array(
        select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
      export_allowed = (p_terms ->> 'exportAllowed')::boolean,
      approved_recipient_region = p_terms ->> 'approvedRecipientRegion',
      starts_at = (p_terms ->> 'startsAt')::timestamptz,
      expires_at = (p_terms ->> 'expiresAt')::timestamptz,
      contract_version = p_terms ->> 'contractVersion',
      contract_fingerprint = p_terms ->> 'contractFingerprint',
      recipient_binding_id = (p_terms ->> 'recipientBindingId')::uuid,
      definition_mapping_fingerprint = p_terms ->> 'definitionMappingFingerprint',
      proposal_fingerprint = p_proposal_fingerprint,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  -- The consent request follows the new fingerprint and roles; any earlier
  -- consent would have named the old fingerprint and is superseded.
  if cross_organization then
    update vortex_access.record_share_grant_consent_requests as requests
    set recipient_organization_id = (p_terms ->> 'recipientOrganizationId')::uuid,
        recipient_cluster_id = (p_terms ->> 'recipientClusterId')::uuid,
        source_cluster_id = (p_terms ->> 'sourceClusterId')::uuid,
        proposed_grant_fingerprint = p_proposal_fingerprint,
        status = 'pending',
        requested_by_organization_account_id = context_account_id,
        requested_at = now_value,
        source_authorizing_role_ids = vortex_access.record_share_grant_uuid_array_internal(
          p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
        recipient_accepting_role_ids = vortex_access.record_share_grant_uuid_array_internal(
          p_terms -> 'recipientAcceptingRoleIds', 1, 100),
        expires_at = (p_terms ->> 'expiresAt')::timestamptz,
        revision = requests.revision + 1,
        changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'revise_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant revision Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, uuid
) to vortex_request;

comment on function vortex_access.revise_record_share_grant_for_administration(
  uuid, bigint, jsonb, text, uuid
) is
  'Fixed protected reviser: replaces the terms and fingerprints of a draft or pending_consent proposal under an exact expected revision, re-checking current share authority and resetting its consent request.';

create or replace function vortex_access.withdraw_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  stored vortex_access.record_share_grants%rowtype;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share grant withdrawal is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal requires an application context';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  -- Withdrawing only narrows, so it needs no field ceiling. The proposer may
  -- always withdraw its own proposal; anyone else needs the same current
  -- row-independent share authority over the proposal's scope that proposing
  -- it would need (the protected share revocation rule, 20260910114716 F2).
  if (stored.created_by_organization_account_id <> context_account_id
      or context_value ? 'delegatedContext' or context_value ? 'supportContext')
    and pg_catalog.jsonb_array_length(
      vortex_access.record_share_grant_source_authority_internal(
        context_value, stored.module_root_id, stored.record_type_id
      ) -> 'recordTypeIds'
    ) = 0 then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  update vortex_access.record_share_grants as grants
  set status = 'revoked',
      revoked_at = now_value,
      revoked_by_organization_account_id = context_account_id,
      revocation_reason = p_reason,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  if stored.consent_request_id is not null then
    update vortex_access.record_share_grant_consent_requests as requests
    set status = 'withdrawn', revision = requests.revision + 1, changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'withdraw_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant withdrawal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) to vortex_request;

comment on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) is
  'Fixed protected withdrawal: its proposer, or a holder of current row-independent share authority over its scope, revokes a draft or pending_consent proposal of the context organisation and application under an exact expected revision and withdraws its consent request.';

create or replace function vortex_access.set_organization_default_application_for_administration(
  p_default_application_root_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  organization_id uuid,
  default_application_root_id uuid,
  revision bigint,
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  decision record;
  outcome_row record;
  activity_subject uuid;
  append_result text;
begin
  if (p_default_application_root_id is not null
      and p_default_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization default application update is invalid';
  end if;

  -- Establish the request identity, then take the same organisation
  -- Access-version lock used by the runtime-settings update and revalidate while
  -- it is held, so a revocation that committed while this operation waited
  -- cannot reach permission evaluation or the settings write.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization default application update is unavailable';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.default_application.set',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.default_application.set'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization default application update is unavailable';
  end if;

  -- Only an exact active installed application of this same organisation may be
  -- selected: an active application registration whose owner root is an
  -- application of the context organisation, still bound to its exact
  -- application release, with an active installation binding for that release.
  -- This is the same installed-application set the organisation address reads
  -- (20260924250000_application_address_resolution.sql).
  if p_default_application_root_id is not null then
    if not exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_definition.roots as root
        on root.root_id = registration.registration_owner_id
        and root.organization_id = registration.organization_id
        and root.kind = 'application'
      where registration.organization_id = context_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_default_application_root_id
        and registration.state = 'active'
        and exists (
          select 1
          from vortex_definition.releases as release
          where release.root_id = root.root_id
            and release.release_revision = registration.source_revision
            and release.content_fingerprint = registration.source_content_fingerprint
            and release.resolution_fingerprint = registration.source_resolution_fingerprint
            and release.compilation_output ->> 'kind' = 'application'
        )
        and exists (
          select 1
          from vortex_module.installation_bindings as binding
          where binding.organization_id = context_organization_id
            and binding.application_root_id = p_default_application_root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
    ) then
      raise exception using errcode = '42501',
        message = 'Organization default application update is unavailable';
    end if;
  end if;

  select updated.* into strict outcome_row
  from vortex_identity.update_organization_default_application_internal(
    context_organization_id, p_expected_revision, p_default_application_root_id
  ) as updated;

  if outcome_row.organization_id is distinct from context_organization_id
    or (outcome_row.changed and outcome_row.revision <> p_expected_revision + 1)
    or (not outcome_row.changed and outcome_row.revision <> p_expected_revision)
    or outcome_row.default_application_root_id is distinct from p_default_application_root_id then
    raise exception using errcode = '55000',
      message = 'Organization default application result is inconsistent';
  end if;

  if outcome_row.changed then
    -- A change records content-free Activity evidence. The subject is the
    -- application being made the default, or the application being cleared.
    activity_subject := coalesce(
      outcome_row.default_application_root_id, outcome_row.previous_default_application_root_id
    );
    if activity_subject is null then
      raise exception using errcode = '55000',
        message = 'Organization default application evidence is inconsistent';
    end if;
    append_result := vortex_activity.append_organization_activity_entry(
      context_organization_id,
      p_activity_id,
      pg_catalog.statement_timestamp(),
      'organization_account',
      context_account_id,
      case
        when outcome_row.default_application_root_id is null
          then 'clear_organization_default_application'
        else 'set_organization_default_application'
      end,
      array[activity_subject]::uuid[],
      array[]::uuid[],
      vortex_context.channel(),
      context_correlation_id,
      'completed'
    );
    if append_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization default application Activity is stale';
    end if;
  end if;

  return query select outcome_row.organization_id, outcome_row.default_application_root_id,
    outcome_row.revision, outcome_row.changed;
end
$function$;

revoke all on function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
) is
  'Fixed protected organisation default-application setter requiring runtime-settings.manage and an exact current revision; accepts only an exact active installed application of the context organisation, or null to clear, and appends content-free Activity for the change.';
