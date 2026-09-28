create or replace function vortex_access.register_flow_run_as_principal(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid,
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
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
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
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_account', 'system')
    or (p_actor_kind = 'specified_account' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null))
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'grant'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'register_flow_run_as_principal',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_application_root_id::text,
      p_release_version,
      p_flow_id::text,
      p_actor_kind,
      coalesce(p_actor_account_id::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), ''),
      coalesce(p_expected_revision::text, '')
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'register_flow_run_as_principal'
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
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  -- An account principal must be active in the named organisation. A System principal must
  -- already have an active Access registration scoped to that organisation and flow.
  if p_actor_kind = 'specified_account' and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_actor_account_id
        and account.organization_id = p_organization_id
        and account.state = 'active'
    )
    or p_actor_kind = 'system' and not exists (
      select 1 from vortex_access.system_actor_grants as actor_grant
      where actor_grant.system_actor_id = p_actor_system_actor_id
        and actor_grant.organization_id = p_organization_id
        and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
        and actor_grant.state = 'active'
    ) then
    raise exception using errcode = '42501', message = 'Flow run-as principal actor is unavailable';
  end if;

  select principal.* into current_principal
  from vortex_access.flow_run_as_principals as principal
  where principal.execution_binding_id = p_execution_binding_id
    and principal.is_current
  for update;

  if found then
    if current_principal.organization_id is distinct from p_organization_id then
      raise exception using errcode = '42501', message = 'Flow run-as principal scope is unavailable';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = '23505', message = 'Flow run-as principal already exists';
    end if;
    if current_principal.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'A revoked flow run-as principal cannot be revived';
    end if;
    if current_principal.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is stale';
    end if;
    if current_principal.application_root_id is distinct from p_application_root_id
      or current_principal.release_version is distinct from p_release_version
      or current_principal.flow_id is distinct from p_flow_id then
      raise exception using errcode = '22023', message = 'Flow run-as principal scope is immutable';
    end if;
    if current_principal.revision >= 9007199254740991 then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is exhausted';
    end if;
    next_revision := current_principal.revision + 1;
  else
    if p_expected_revision is not null then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal is unavailable';
    end if;
    next_revision := 1;
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow run-as principal expiry must be in the future';
  end if;

  if next_revision > 1 then
    update vortex_access.flow_run_as_principals as principal
    set is_current = false
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = current_principal.revision;
  end if;

  insert into vortex_access.flow_run_as_principals (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version, flow_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version, p_flow_id,
    p_actor_kind, p_actor_account_id, p_actor_system_actor_id,
    p_expires_at, 'active', operation_at, p_actor_organization_account_id,
    authority.correlation_id, null
  ) returning * into stored_principal;

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
      then 'register_flow_run_as_principal'
      else 'replace_flow_run_as_principal'
    end,
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
    'register_flow_run_as_principal', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
) is
  'Registers or replaces one exact compiled flow run-as principal under the existing execution-binding administration authority.';
