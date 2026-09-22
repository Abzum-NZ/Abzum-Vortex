-- #685: Flow execution authority bindings in Access runtime.
-- An authorised administrator can register, replace, read and revoke one exact,
-- revisioned execution-authority binding for a published application flow node
-- and protected operation.
-- Editing, installing or delegating roles cannot create this authority.

begin;

create table vortex_access.flow_execution_bindings (
  execution_binding_id uuid not null,
  revision bigint not null,
  is_current boolean not null default true,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid not null,
  release_version text not null,
  flow_id uuid not null,
  node_id uuid not null,
  operation_owner_kind text not null check (operation_owner_kind in ('application', 'module', 'service')),
  operation_owner_id uuid not null,
  operation_id uuid not null,
  actor_kind text not null check (actor_kind in ('specified_user', 'system')),
  actor_organization_account_id uuid references vortex_identity.organization_accounts (organization_account_id),
  actor_system_actor_id uuid,
  permitted_invokers jsonb not null,
  permitted_surfaces jsonb not null,
  permitted_inputs jsonb not null,
  expires_at timestamptz,
  state text not null check (state in ('active', 'revoked')),
  recorded_at timestamptz not null,
  revoked_at timestamptz,
  created_by_actor_id uuid not null,
  creation_correlation_id uuid not null,
  revoked_by_actor_id uuid,
  revocation_correlation_id uuid,
  primary key (execution_binding_id, revision),
  constraint flow_execution_bindings_ids_non_nil check (
    vortex_context.is_non_nil_uuid(execution_binding_id::text)
    and vortex_context.is_non_nil_uuid(organization_id::text)
    and vortex_context.is_non_nil_uuid(application_root_id::text)
    and vortex_context.is_non_nil_uuid(flow_id::text)
    and vortex_context.is_non_nil_uuid(node_id::text)
    and vortex_context.is_non_nil_uuid(operation_owner_id::text)
    and vortex_context.is_non_nil_uuid(operation_id::text)
    and vortex_context.is_non_nil_uuid(created_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(creation_correlation_id::text)
    and (actor_organization_account_id is null or vortex_context.is_non_nil_uuid(actor_organization_account_id::text))
    and (actor_system_actor_id is null or vortex_context.is_non_nil_uuid(actor_system_actor_id::text))
    and (revoked_by_actor_id is null or vortex_context.is_non_nil_uuid(revoked_by_actor_id::text))
    and (revocation_correlation_id is null or vortex_context.is_non_nil_uuid(revocation_correlation_id::text))
  ),
  constraint flow_execution_bindings_actor_valid check (
    (actor_kind = 'specified_user' and actor_organization_account_id is not null and actor_system_actor_id is null)
    or (actor_kind = 'system' and actor_system_actor_id is not null and actor_organization_account_id is null)
  ),
  constraint flow_execution_bindings_revision_valid check (
    revision between 1 and 9007199254740991
  ),
  constraint flow_execution_bindings_state_revoked_valid check (
    (state = 'revoked' and revoked_at is not null and revoked_by_actor_id is not null and revocation_correlation_id is not null)
    or (state = 'active' and revoked_at is null and revoked_by_actor_id is null and revocation_correlation_id is null)
  ),
  constraint flow_execution_bindings_timestamps_valid check (
    recorded_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null or (expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz) and expires_at > recorded_at))
    and (revoked_at is null or (revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz) and revoked_at >= recorded_at))
  )
);

create unique index flow_execution_bindings_current_unique
  on vortex_access.flow_execution_bindings (execution_binding_id)
  where is_current;

create unique index flow_execution_bindings_active_scope_unique
  on vortex_access.flow_execution_bindings (
    organization_id,
    application_root_id,
    release_version,
    flow_id,
    node_id,
    operation_owner_kind,
    operation_owner_id,
    operation_id,
    actor_kind,
    coalesce(actor_organization_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(actor_system_actor_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where is_current and state = 'active';

alter table vortex_access.flow_execution_bindings enable row level security;
alter table vortex_access.flow_execution_bindings force row level security;

revoke all on table vortex_access.flow_execution_bindings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- ============================================================================
-- Canonical JSON serializer for flow execution binding
-- ============================================================================
create function vortex_access.flow_execution_binding_to_json(
  b vortex_access.flow_execution_bindings
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'executionBindingId', b.execution_binding_id,
    'organizationId', b.organization_id,
    'applicationRootId', b.application_root_id,
    'releaseVersion', b.release_version,
    'flowId', b.flow_id,
    'nodeId', b.node_id,
    'operation', pg_catalog.jsonb_build_object(
      'owner', case
        when b.operation_owner_kind = 'application' then pg_catalog.jsonb_build_object('kind', 'application', 'applicationRootId', b.operation_owner_id)
        when b.operation_owner_kind = 'module' then pg_catalog.jsonb_build_object('kind', 'module', 'moduleRootId', b.operation_owner_id)
        else pg_catalog.jsonb_build_object('kind', 'service', 'serviceId', b.operation_owner_id)
      end,
      'operationId', b.operation_id
    ),
    'actor', case
      when b.actor_kind = 'specified_user' then pg_catalog.jsonb_build_object('kind', 'specified_user', 'organizationAccountId', b.actor_organization_account_id)
      else pg_catalog.jsonb_build_object('kind', 'system', 'systemActorId', b.actor_system_actor_id)
    end,
    'permittedInvokers', b.permitted_invokers,
    'permittedSurfaces', b.permitted_surfaces,
    'permittedInputs', b.permitted_inputs,
    'state', b.state,
    'revision', b.revision,
    'recordedAt', b.recorded_at
  )
  || case when b.expires_at is not null then pg_catalog.jsonb_build_object('expiresAt', b.expires_at) else '{}'::jsonb end
  || case when b.revoked_at is not null then pg_catalog.jsonb_build_object('revokedAt', b.revoked_at) else '{}'::jsonb end;
$function$;

revoke all on function vortex_access.flow_execution_binding_to_json(vortex_access.flow_execution_bindings)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- ============================================================================
-- Register or replace one flow execution binding
-- ============================================================================
create function vortex_access.register_flow_execution_binding(
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
  p_actor_organization_account_id_param uuid,
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
  ctx jsonb;
  decision record;
  v_tenant_id uuid;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  existing_binding vortex_access.flow_execution_bindings%rowtype;
  current_b vortex_access.flow_execution_bindings%rowtype;
  inserted_b vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  new_correlation_id uuid;
  next_revision bigint;
  activity_result text;
  subject_ids uuid[];
  subject_revisions bigint[];
  invoker_item jsonb;
  permits_system boolean := false;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null or p_release_version = ''
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_context.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null or p_operation_owner_kind not in ('application', 'module', 'service')
    or p_operation_owner_id is null or not vortex_context.is_non_nil_uuid(p_operation_owner_id::text)
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (p_actor_organization_account_id_param is null or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id_param::text) or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text) or p_actor_organization_account_id_param is not null))
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

  -- Validate invoker kinds and actor-invoker agreement
  for invoker_item in select value from pg_catalog.jsonb_array_elements(p_permitted_invokers) loop
    if invoker_item ->> 'kind' = 'system' then
      permits_system := true;
    elsif invoker_item ->> 'kind' = 'organization_account' then
      if not vortex_context.is_non_nil_uuid(invoker_item ->> 'organizationAccountId') then
        raise exception using errcode = '22023', message = 'Permitted invoker organization account is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Permitted invoker kind is invalid';
    end if;
  end loop;

  if p_actor_kind = 'system' and not permits_system then
    raise exception using errcode = '22023', message = 'A system execution binding must permit the system origin';
  end if;
  if p_actor_kind = 'specified_user' and permits_system then
    raise exception using errcode = '22023', message = 'A specified-user execution binding cannot permit the system origin';
  end if;

  ctx := vortex_access.validated_human_request_context();
  if (ctx ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (ctx ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (ctx ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Request context does not match execution authority administrator';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.assignments.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  select o.tenant_id into v_tenant_id
  from vortex_identity.organizations o
  where o.organization_id = p_organization_id and o.state = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Organization is unavailable';
  end if;

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
      coalesce(p_actor_organization_account_id_param::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      p_permitted_invokers::text,
      p_permitted_surfaces::text,
      p_permitted_inputs::text,
      coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = v_tenant_id
    and stored.operation_key = 'register_flow_execution_binding'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select b.* into existing_binding
    from vortex_access.flow_execution_bindings b
    where b.execution_binding_id = p_execution_binding_id
      and b.is_current;
    if not found then
      raise exception using errcode = '42501', message = 'Execution binding receipt is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json(existing_binding),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select b.* into current_b
  from vortex_access.flow_execution_bindings b
  where b.execution_binding_id = p_execution_binding_id
    and b.is_current
  for update;

  if found then
    if current_b.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'Revoked flow execution binding cannot be replaced';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = 'V3102', message = 'Expected revision is required to replace a flow execution binding';
    end if;
    if current_b.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
    end if;
    if current_b.organization_id is distinct from p_organization_id
      or current_b.application_root_id is distinct from p_application_root_id
      or current_b.release_version is distinct from p_release_version
      or current_b.flow_id is distinct from p_flow_id
      or current_b.node_id is distinct from p_node_id
      or current_b.operation_owner_kind is distinct from p_operation_owner_kind
      or current_b.operation_owner_id is distinct from p_operation_owner_id
      or current_b.operation_id is distinct from p_operation_id
      or current_b.actor_kind is distinct from p_actor_kind
      or current_b.actor_organization_account_id is distinct from p_actor_organization_account_id_param
      or current_b.actor_system_actor_id is distinct from p_actor_system_actor_id then
      raise exception using errcode = '22023', message = 'Execution binding scope is immutable';
    end if;

    next_revision := current_b.revision + 1;
    update vortex_access.flow_execution_bindings
    set is_current = false
    where execution_binding_id = p_execution_binding_id and revision = current_b.revision;
  else
    if p_expected_revision is not null and p_expected_revision <> 1 then
      raise exception using errcode = 'V3102', message = 'Flow execution binding does not exist at expected revision';
    end if;
    next_revision := 1;
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow execution binding expiry must be in the future';
  end if;

  new_correlation_id := (ctx ->> 'correlationId')::uuid;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, revoked_at,
    created_by_actor_id, creation_correlation_id,
    revoked_by_actor_id, revocation_correlation_id
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version,
    p_flow_id, p_node_id, p_operation_owner_kind, p_operation_owner_id, p_operation_id,
    p_actor_kind, p_actor_organization_account_id_param, p_actor_system_actor_id,
    p_permitted_invokers, p_permitted_surfaces, p_permitted_inputs,
    p_expires_at, 'active', operation_at, null,
    p_actor_organization_account_id, new_correlation_id,
    null, null
  ) returning * into inserted_b;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    case when next_revision = 1 then 'register_flow_execution_binding' else 'replace_flow_execution_binding' end,
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    'web',
    new_correlation_id,
    'completed'
  );

  if activity_result is distinct from 'inserted' and activity_result is distinct from 'already_recorded' then
    raise exception using errcode = '40001', message = 'Organization Activity is stale';
  end if;

  if p_organization_id < p_execution_binding_id then
    subject_ids := array[p_organization_id, p_execution_binding_id];
    subject_revisions := array[(ctx ->> 'accessVersion')::bigint, next_revision];
  else
    subject_ids := array[p_execution_binding_id, p_organization_id];
    subject_revisions := array[next_revision, (ctx ->> 'accessVersion')::bigint];
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id,
    p_actor_organization_account_id,
    v_tenant_id,
    'register_flow_execution_binding',
    p_duplicate_key,
    command_fingerprint,
    subject_ids,
    subject_revisions,
    operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json(inserted_b),
    new_correlation_id,
    operation_at;
  return;
end
$function$;

revoke all on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) to vortex_request;

-- ============================================================================
-- Revoke one flow execution binding
-- ============================================================================
create function vortex_access.revoke_flow_execution_binding(
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
  ctx jsonb;
  decision record;
  v_tenant_id uuid;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  existing_binding vortex_access.flow_execution_bindings%rowtype;
  current_b vortex_access.flow_execution_bindings%rowtype;
  inserted_b vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  new_correlation_id uuid;
  next_revision bigint;
  activity_result text;
  subject_ids uuid[];
  subject_revisions bigint[];
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow execution binding revoke command is invalid';
  end if;

  ctx := vortex_access.validated_human_request_context();
  if (ctx ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (ctx ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (ctx ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Request context does not match execution authority administrator';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.assignments.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  select o.tenant_id into v_tenant_id
  from vortex_identity.organizations o
  where o.organization_id = p_organization_id and o.state = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Organization is unavailable';
  end if;

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
    and stored.tenant_id = v_tenant_id
    and stored.operation_key = 'revoke_flow_execution_binding'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select b.* into existing_binding
    from vortex_access.flow_execution_bindings b
    where b.execution_binding_id = p_execution_binding_id
      and b.is_current;
    if not found then
      raise exception using errcode = '42501', message = 'Execution binding receipt is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json(existing_binding),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select b.* into current_b
  from vortex_access.flow_execution_bindings b
  where b.execution_binding_id = p_execution_binding_id
    and b.is_current
  for update;

  if not found then
    raise exception using errcode = 'V3101', message = 'Flow execution binding is unavailable';
  end if;

  if current_b.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Flow execution binding scope is unavailable';
  end if;

  if current_b.state = 'revoked' then
    raise exception using errcode = 'V3101', message = 'Flow execution binding is already revoked';
  end if;

  if current_b.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  new_correlation_id := (ctx ->> 'correlationId')::uuid;
  next_revision := current_b.revision + 1;

  update vortex_access.flow_execution_bindings
  set is_current = false
  where execution_binding_id = p_execution_binding_id
    and revision = current_b.revision;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, revoked_at,
    created_by_actor_id, creation_correlation_id,
    revoked_by_actor_id, revocation_correlation_id
  ) values (
    current_b.execution_binding_id, next_revision, true,
    current_b.organization_id, current_b.application_root_id, current_b.release_version,
    current_b.flow_id, current_b.node_id, current_b.operation_owner_kind, current_b.operation_owner_id, current_b.operation_id,
    current_b.actor_kind, current_b.actor_organization_account_id, current_b.actor_system_actor_id,
    current_b.permitted_invokers, current_b.permitted_surfaces, current_b.permitted_inputs,
    current_b.expires_at, 'revoked', operation_at, operation_at,
    current_b.created_by_actor_id, current_b.creation_correlation_id,
    p_actor_organization_account_id, new_correlation_id
  ) returning * into inserted_b;

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_execution_binding',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    'web',
    new_correlation_id,
    'completed'
  );

  if activity_result is distinct from 'inserted' and activity_result is distinct from 'already_recorded' then
    raise exception using errcode = '40001', message = 'Organization Activity is stale';
  end if;

  if p_organization_id < p_execution_binding_id then
    subject_ids := array[p_organization_id, p_execution_binding_id];
    subject_revisions := array[(ctx ->> 'accessVersion')::bigint, next_revision];
  else
    subject_ids := array[p_execution_binding_id, p_organization_id];
    subject_revisions := array[next_revision, (ctx ->> 'accessVersion')::bigint];
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id,
    p_actor_organization_account_id,
    v_tenant_id,
    'revoke_flow_execution_binding',
    p_duplicate_key,
    command_fingerprint,
    subject_ids,
    subject_revisions,
    operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json(inserted_b),
    new_correlation_id,
    operation_at;
  return;
end
$function$;

revoke all on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

-- ============================================================================
-- Read one exact flow execution binding with full scope matching
-- ============================================================================
create function vortex_access.read_flow_execution_binding(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
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
  p_actor_organization_account_id_param uuid,
  p_actor_system_actor_id uuid
)
returns table (
  outcome text,
  effective_state text,
  result jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  decision record;
  current_b vortex_access.flow_execution_bindings%rowtype;
  computed_effective_state text;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null or p_release_version = ''
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_context.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null or p_operation_owner_kind not in ('application', 'module', 'service')
    or p_operation_owner_id is null or not vortex_context.is_non_nil_uuid(p_operation_owner_id::text)
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (p_actor_organization_account_id_param is null or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id_param::text) or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text) or p_actor_organization_account_id_param is not null)) then
    raise exception using errcode = '22023', message = 'Flow execution binding read command is invalid';
  end if;

  ctx := vortex_access.validated_human_request_context();
  if (ctx ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (ctx ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (ctx ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Request context does not match execution authority administrator';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.assignments.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '9901c0dc-8bac-45c7-be0b-3642cb839bb1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Flow execution binding read is unavailable';
  end if;

  select b.* into current_b
  from vortex_access.flow_execution_bindings b
  where b.execution_binding_id = p_execution_binding_id
    and b.is_current;

  if not found then
    return query select 'unavailable'::text, null::text, null::jsonb;
    return;
  end if;

  -- Exact scope match required; any scope mismatch returns unavailable rather than a partial match
  if current_b.organization_id is distinct from p_organization_id
    or current_b.application_root_id is distinct from p_application_root_id
    or current_b.release_version is distinct from p_release_version
    or current_b.flow_id is distinct from p_flow_id
    or current_b.node_id is distinct from p_node_id
    or current_b.operation_owner_kind is distinct from p_operation_owner_kind
    or current_b.operation_owner_id is distinct from p_operation_owner_id
    or current_b.operation_id is distinct from p_operation_id
    or current_b.actor_kind is distinct from p_actor_kind
    or current_b.actor_organization_account_id is distinct from p_actor_organization_account_id_param
    or current_b.actor_system_actor_id is distinct from p_actor_system_actor_id then
    return query select 'unavailable'::text, null::text, null::jsonb;
    return;
  end if;

  if current_b.state = 'revoked' then
    computed_effective_state := 'revoked';
  elsif current_b.expires_at is not null and current_b.expires_at <= pg_catalog.clock_timestamp() then
    computed_effective_state := 'expired';
  else
    computed_effective_state := 'active';
  end if;

  return query select 'available'::text,
    computed_effective_state,
    vortex_access.flow_execution_binding_to_json(current_b);
  return;
end
$function$;

revoke all on function vortex_access.read_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) to vortex_request;

commit;
