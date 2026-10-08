create or replace function vortex_access.revoke_flow_run_as_principal(
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
  context_value jsonb;
  locked_access_version bigint;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
  operation_at timestamptz;
  receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
  record_permission_scope jsonb;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal revoke command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (context_value ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Flow run-as principal administration is unavailable';
  end if;
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Flow run-as principal scope is unavailable';
  end if;
  if locked_access_version is distinct from (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Flow run-as principal access authority changed';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'revoke'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'revoke_flow_run_as_principal',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_expected_revision::text
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'revoke_flow_run_as_principal'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_execution_binding_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow run-as principal duplicate conflicts';
    end if;
    select principal.* into stored_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = receipt.subject_revisions[1]
      and principal.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow run-as principal replay is unavailable';
    end if;
    record_permission_scope := pg_catalog.jsonb_build_object(
      'executionBindingId', stored_principal.execution_binding_id,
      'organizationId', stored_principal.organization_id,
      'applicationRootId', stored_principal.application_root_id,
      'releaseVersion', stored_principal.release_version,
      'flowId', stored_principal.flow_id,
      'actorKind', stored_principal.actor_kind,
      'actorId', coalesce(stored_principal.actor_system_actor_id,
        stored_principal.actor_organization_account_id),
      'organizationAccountId', p_actor_organization_account_id,
      'accessVersion', authority.access_version,
      'correlationId', authority.correlation_id
    );
    perform vortex_access.system_record_permission_registration_authority_internal(
      'revoke', record_permission_scope, stored_principal.record_permissions, '[]'::jsonb
    );
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select principal.* into current_principal
  from vortex_access.flow_run_as_principals as principal
  where principal.execution_binding_id = p_execution_binding_id
    and principal.organization_id = p_organization_id
    and principal.is_current
  for update;

  if not found or current_principal.state = 'revoked' then
    raise exception using errcode = 'V3101', message = 'Flow run-as principal is unavailable';
  end if;
  if current_principal.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is stale';
  end if;
  if current_principal.revision >= 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is exhausted';
  end if;

  record_permission_scope := pg_catalog.jsonb_build_object(
    'executionBindingId', current_principal.execution_binding_id,
    'organizationId', current_principal.organization_id,
    'applicationRootId', current_principal.application_root_id,
    'releaseVersion', current_principal.release_version,
    'flowId', current_principal.flow_id,
    'actorKind', current_principal.actor_kind,
    'actorId', coalesce(current_principal.actor_system_actor_id,
      current_principal.actor_organization_account_id),
    'organizationAccountId', p_actor_organization_account_id,
    'accessVersion', authority.access_version,
    'correlationId', authority.correlation_id
  );
  perform vortex_access.system_record_permission_registration_authority_internal(
    'revoke', record_permission_scope, current_principal.record_permissions, '[]'::jsonb
  );

  operation_at := pg_catalog.clock_timestamp();
  next_revision := current_principal.revision + 1;

  update vortex_access.flow_run_as_principals as principal
  set is_current = false
  where principal.execution_binding_id = p_execution_binding_id
    and principal.revision = current_principal.revision;

  insert into vortex_access.flow_run_as_principals (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version, flow_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at,
    record_permissions
  ) values (
    current_principal.execution_binding_id, next_revision, true,
    current_principal.organization_id, current_principal.application_root_id,
    current_principal.release_version, current_principal.flow_id,
    current_principal.actor_kind, current_principal.actor_organization_account_id,
    current_principal.actor_system_actor_id, current_principal.expires_at, 'revoked',
    operation_at, p_actor_organization_account_id, authority.correlation_id, operation_at,
    current_principal.record_permissions
  ) returning * into stored_principal;

  if current_principal.actor_kind = 'system' then
    perform vortex_access.refresh_system_record_execution_grant_internal(
      p_organization_id, current_principal.application_root_id,
      current_principal.flow_id, current_principal.actor_system_actor_id
    );
  end if;

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
    'revoke_flow_run_as_principal',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow run-as principal Activity is stale';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    receipt_id, p_actor_organization_account_id, authority.tenant_id,
    'revoke_flow_run_as_principal', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow run-as principal at its next revision under the existing execution-binding authority and refreshes only its source-valid Record cache tuple.';
