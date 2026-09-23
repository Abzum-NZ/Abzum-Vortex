-- #685: Access-owned execution-authority bindings for published application flow nodes.
-- An authorised administrator explicitly registers, replaces, reads and revokes one
-- exact, revisioned grant for an organisation, application release, flow node,
-- protected operation and effective actor, bounded by permitted invokers,
-- surfaces, declared inputs and an optional expiry. Grants are stored apart from
-- definitions, so flow editing, installation, copying or role-management
-- delegation can never create, broaden or revive execution authority. Granting
-- requires the current access-assignment permission plus organisation-wide
-- delegation authority; a bounded role-management delegate cannot grant it.
-- No execution happens here; #686 resolves the effective actor from a binding.

begin;

create table vortex_access.flow_execution_bindings (
  execution_binding_id uuid not null,
  revision bigint not null,
  is_current boolean not null,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid not null,
  release_version text not null,
  flow_id uuid not null,
  node_id uuid not null,
  operation_owner_kind text not null,
  operation_owner_id uuid not null,
  operation_id uuid not null,
  actor_kind text not null,
  actor_organization_account_id uuid
    references vortex_identity.organization_accounts (organization_account_id),
  actor_system_actor_id uuid,
  permitted_invokers jsonb not null,
  permitted_surfaces jsonb not null,
  permitted_inputs jsonb not null,
  expires_at timestamptz,
  state text not null,
  recorded_at timestamptz not null,
  recorded_by_actor_id uuid not null,
  recorded_correlation_id uuid not null,
  revoked_at timestamptz,
  primary key (execution_binding_id, revision),
  constraint flow_execution_bindings_ids_non_nil check (
    vortex_context.is_non_nil_uuid(execution_binding_id::text)
    and vortex_context.is_non_nil_uuid(organization_id::text)
    and vortex_context.is_non_nil_uuid(application_root_id::text)
    and vortex_context.is_non_nil_uuid(flow_id::text)
    and vortex_context.is_non_nil_uuid(node_id::text)
    and vortex_context.is_non_nil_uuid(operation_owner_id::text)
    and vortex_context.is_non_nil_uuid(operation_id::text)
    and vortex_context.is_non_nil_uuid(recorded_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(recorded_correlation_id::text)
    and (actor_organization_account_id is null
      or vortex_context.is_non_nil_uuid(actor_organization_account_id::text))
    and (actor_system_actor_id is null
      or vortex_context.is_non_nil_uuid(actor_system_actor_id::text))
  ),
  constraint flow_execution_bindings_release_version_valid check (
    release_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint flow_execution_bindings_operation_owner_valid check (
    operation_owner_kind in ('application', 'module', 'platform_service')
    and (operation_owner_kind <> 'application' or operation_owner_id = application_root_id)
  ),
  constraint flow_execution_bindings_actor_valid check (
    (actor_kind = 'specified_user'
      and actor_organization_account_id is not null and actor_system_actor_id is null)
    or (actor_kind = 'system'
      and actor_system_actor_id is not null and actor_organization_account_id is null)
  ),
  constraint flow_execution_bindings_bounds_shape check (
    pg_catalog.jsonb_typeof(permitted_invokers) = 'array'
    and pg_catalog.jsonb_array_length(permitted_invokers) between 1 and 20
    and pg_catalog.jsonb_typeof(permitted_surfaces) = 'array'
    and pg_catalog.jsonb_array_length(permitted_surfaces) between 1 and 5
    and pg_catalog.jsonb_typeof(permitted_inputs) = 'array'
    and pg_catalog.jsonb_array_length(permitted_inputs) <= 20
  ),
  constraint flow_execution_bindings_revision_valid check (
    revision between 1 and 9007199254740991
  ),
  constraint flow_execution_bindings_state_valid check (
    (state = 'active' and revoked_at is null)
    or (state = 'revoked' and revoked_at is not null and revoked_at = recorded_at)
  ),
  constraint flow_execution_bindings_timestamps_valid check (
    recorded_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
  )
);

comment on table vortex_access.flow_execution_bindings is
  'Append-only revisions of explicit execution-authority grants. Only the protected register/replace/revoke operations write here; definitions, installation and role delegation never do.';

create unique index flow_execution_bindings_current_unique
  on vortex_access.flow_execution_bindings (execution_binding_id)
  where is_current;

-- One live grant per exact scope and effective actor; a second grant for the
-- same scope must replace or follow revocation of the first.
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
-- Canonical binding projection (matches flowExecutionBindingSchema)
-- ============================================================================
create function vortex_access.flow_execution_binding_timestamp_internal(p_value timestamptz)
returns text
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$function$;

create function vortex_access.flow_execution_binding_to_json_internal(
  b vortex_access.flow_execution_bindings
)
returns jsonb
language sql
stable
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
      'owner', case b.operation_owner_kind
        when 'application' then pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', b.operation_owner_id)
        when 'module' then pg_catalog.jsonb_build_object(
          'kind', 'module', 'moduleRootId', b.operation_owner_id)
        else pg_catalog.jsonb_build_object(
          'kind', 'platform_service', 'serviceId', b.operation_owner_id)
      end,
      'operationId', b.operation_id
    ),
    'actor', case b.actor_kind
      when 'specified_user' then pg_catalog.jsonb_build_object(
        'kind', 'specified_user', 'organizationAccountId', b.actor_organization_account_id)
      else pg_catalog.jsonb_build_object('kind', 'system', 'systemActorId', b.actor_system_actor_id)
    end,
    'permittedInvokers', b.permitted_invokers,
    'permittedSurfaces', b.permitted_surfaces,
    'permittedInputs', b.permitted_inputs,
    'state', b.state,
    'revision', b.revision,
    'recordedAt', vortex_access.flow_execution_binding_timestamp_internal(b.recorded_at)
  )
  || case when b.expires_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'expiresAt', vortex_access.flow_execution_binding_timestamp_internal(b.expires_at)) end
  || case when b.revoked_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'revokedAt', vortex_access.flow_execution_binding_timestamp_internal(b.revoked_at)) end
$function$;

revoke all on function vortex_access.flow_execution_binding_timestamp_internal(timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_access.flow_execution_binding_to_json_internal(
  vortex_access.flow_execution_bindings
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- ============================================================================
-- Administrator authority, re-established from the protected request context
-- ============================================================================
-- 'grant' and 'revoke' need the access-assignment permission plus current
-- organisation-wide delegation authority, so neither a bounded role-management
-- delegate nor an application editor or installer can create or remove
-- execution authority. 'read' needs the access-assignment read permission.
create function vortex_access.flow_execution_binding_authority_internal(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_organization_id uuid,
  p_mode text
)
returns table (
  tenant_id uuid,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
  operation_value text;
  organization_tenant_id uuid;
begin
  if p_mode is null or p_mode not in ('grant', 'revoke', 'read') then
    raise exception using errcode = '22023', message = 'Flow execution binding authority mode is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (context_value ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  operation_value := case p_mode
    when 'grant' then 'platform.organization.execution_bindings.grant'
    when 'revoke' then 'platform.organization.execution_bindings.revoke'
    else 'platform.organization.execution_bindings.read'
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object(
        'actionKind', case when p_mode = 'read' then 'read' else 'manage' end),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', case when p_mode = 'read'
          then '9901c0dc-8bac-45c7-be0b-3642cb839bb1'
          else '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
        end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', case p_mode
        when 'grant' then pg_catalog.jsonb_build_object(
          'kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'none'),
          'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'))
        when 'revoke' then pg_catalog.jsonb_build_object(
          'kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
          'after', pg_catalog.jsonb_build_object('kind', 'none'))
        else pg_catalog.jsonb_build_object('kind', 'permission')
      end
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from p_organization_id
    or decision.organization_account_id is distinct from p_actor_organization_account_id
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  select organization.tenant_id into organization_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
    and organization.state = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  return query select organization_tenant_id,
    decision.access_version,
    decision.correlation_id;
end
$function$;

revoke all on function vortex_access.flow_execution_binding_authority_internal(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

-- ============================================================================
-- Register (no expected revision) or replace (exact expected revision)
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
          'web', 'mcp', 'programmatic_interface', 'durable_workflow', 'system')
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
    'web',
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
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) to vortex_request;

-- ============================================================================
-- Revoke one exact active binding at its next revision
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
    'web',
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
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

-- ============================================================================
-- Read one exact current binding; any scope mismatch is unavailable
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
  p_actor_account_id uuid,
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
  authority record;
  current_binding vortex_access.flow_execution_bindings%rowtype;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
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
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null)) then
    raise exception using errcode = '22023', message = 'Flow execution binding read command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'read'
  ) as granted;

  select binding.* into current_binding
  from vortex_access.flow_execution_bindings as binding
  where binding.execution_binding_id = p_execution_binding_id
    and binding.organization_id = p_organization_id
    and binding.is_current
    and binding.application_root_id = p_application_root_id
    and binding.release_version = p_release_version
    and binding.flow_id = p_flow_id
    and binding.node_id = p_node_id
    and binding.operation_owner_kind = p_operation_owner_kind
    and binding.operation_owner_id = p_operation_owner_id
    and binding.operation_id = p_operation_id
    and binding.actor_kind = p_actor_kind
    and binding.actor_organization_account_id is not distinct from p_actor_account_id
    and binding.actor_system_actor_id is not distinct from p_actor_system_actor_id;

  if not found then
    return query select 'unavailable'::text, null::text, null::jsonb;
    return;
  end if;

  return query select 'available'::text,
    case
      when current_binding.state = 'revoked' then 'revoked'
      when current_binding.expires_at is not null
        and current_binding.expires_at <= pg_catalog.clock_timestamp() then 'expired'
      else 'active'
    end,
    vortex_access.flow_execution_binding_to_json_internal(current_binding);
end
$function$;

revoke all on function vortex_access.read_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) to vortex_request;

commit;
