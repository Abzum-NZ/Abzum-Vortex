begin;

create table vortex_access.flow_run_as_principals (
  execution_binding_id uuid not null,
  revision bigint not null,
  is_current boolean not null,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid not null,
  release_version text not null,
  flow_id uuid not null,
  actor_kind text not null,
  actor_organization_account_id uuid
    references vortex_identity.organization_accounts (organization_account_id),
  actor_system_actor_id uuid,
  expires_at timestamptz,
  state text not null,
  recorded_at timestamptz not null,
  recorded_by_actor_id uuid not null,
  recorded_correlation_id uuid not null,
  revoked_at timestamptz,
  primary key (execution_binding_id, revision),
  constraint flow_run_as_principals_ids_non_nil check (
    vortex_context.is_non_nil_uuid(execution_binding_id::text)
    and vortex_context.is_non_nil_uuid(organization_id::text)
    and vortex_context.is_non_nil_uuid(application_root_id::text)
    and vortex_context.is_non_nil_uuid(flow_id::text)
    and vortex_context.is_non_nil_uuid(recorded_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(recorded_correlation_id::text)
    and (actor_organization_account_id is null
      or vortex_context.is_non_nil_uuid(actor_organization_account_id::text))
    and (actor_system_actor_id is null
      or vortex_context.is_non_nil_uuid(actor_system_actor_id::text))
  ),
  constraint flow_run_as_principals_release_version_valid check (
    release_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint flow_run_as_principals_actor_valid check (
    (actor_kind = 'specified_account'
      and actor_organization_account_id is not null and actor_system_actor_id is null)
    or (actor_kind = 'system'
      and actor_system_actor_id is not null and actor_organization_account_id is null)
  ),
  constraint flow_run_as_principals_revision_valid check (
    revision between 1 and 9007199254740991
  ),
  constraint flow_run_as_principals_state_valid check (
    (state = 'active' and revoked_at is null)
    or (state = 'revoked' and revoked_at is not null and revoked_at = recorded_at)
  ),
  constraint flow_run_as_principals_timestamps_valid check (
    recorded_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
  )
);

comment on table vortex_access.flow_run_as_principals is
  'Append-only revisions mapping one compiled flow run-as binding to an organisation account or registered System actor; these records confer no protected-operation grants.';

create unique index flow_run_as_principals_current_unique
  on vortex_access.flow_run_as_principals (execution_binding_id)
  where is_current;

alter table vortex_access.flow_run_as_principals enable row level security;
alter table vortex_access.flow_run_as_principals force row level security;

revoke all on table vortex_access.flow_run_as_principals
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create or replace function vortex_access.flow_run_as_principal_to_json_internal(
  p_principal vortex_access.flow_run_as_principals
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'executionBindingId', p_principal.execution_binding_id,
    'organizationId', p_principal.organization_id,
    'applicationRootId', p_principal.application_root_id,
    'releaseVersion', p_principal.release_version,
    'flowId', p_principal.flow_id,
    'actor', case p_principal.actor_kind
      when 'specified_account' then pg_catalog.jsonb_build_object(
        'kind', 'specified_account',
        'organizationAccountId', p_principal.actor_organization_account_id)
      else pg_catalog.jsonb_build_object(
        'kind', 'system', 'systemActorId', p_principal.actor_system_actor_id)
    end,
    'state', p_principal.state,
    'revision', p_principal.revision,
    'recordedAt', vortex_context.format_timestamp_utc(p_principal.recorded_at)
  )
  || case when p_principal.expires_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'expiresAt', vortex_context.format_timestamp_utc(p_principal.expires_at)) end
  || case when p_principal.revoked_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'revokedAt', vortex_context.format_timestamp_utc(p_principal.revoked_at)) end
$function$;

revoke all on function vortex_access.flow_run_as_principal_to_json_internal(
  vortex_access.flow_run_as_principals
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.flow_run_as_principal_to_json_internal(
  vortex_access.flow_run_as_principals
) is
  'Projects one stored flow run-as principal revision into its canonical JSON form.';

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
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal revoke command is invalid';
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
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    current_principal.execution_binding_id, next_revision, true,
    current_principal.organization_id, current_principal.application_root_id,
    current_principal.release_version, current_principal.flow_id,
    current_principal.actor_kind, current_principal.actor_organization_account_id,
    current_principal.actor_system_actor_id, current_principal.expires_at, 'revoked',
    operation_at, p_actor_organization_account_id, authority.correlation_id, operation_at
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
  'Revokes one exact current flow run-as principal at its next revision under the existing execution-binding administration authority.';

create or replace function vortex_access.read_flow_run_as_principal_for_run(
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid
)
returns table (
  outcome text,
  result jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_principal vortex_access.flow_run_as_principals%rowtype;
  actor_state text;
begin
  if p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal read command is invalid';
  end if;

  -- Share-lock the exact current revision. A concurrent replace or revoke either commits first
  -- and becomes the row this statement sees, or waits until this run has established its actor.
  for attempt in 1..2 loop
    select principal.* into current_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.organization_id = p_organization_id
      and principal.application_root_id = p_application_root_id
      and principal.release_version = p_release_version
      and principal.flow_id = p_flow_id
      and principal.is_current
    for share;
    exit when found;
  end loop;

  if current_principal.execution_binding_id is null
    or current_principal.state <> 'active'
    or (current_principal.expires_at is not null
      and current_principal.expires_at <= pg_catalog.clock_timestamp()) then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  -- Keep lifecycle changes ordered with a concurrent account suspension or closure.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = current_principal.organization_id
  for share of version;
  if not found then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.actor_kind = 'specified_account' then
    select account.state into actor_state
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = current_principal.actor_organization_account_id
      and account.organization_id = current_principal.organization_id
    for share of account;
    if actor_state is distinct from 'active' then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  else
    select actor_grant.state into actor_state
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.system_actor_id = current_principal.actor_system_actor_id
      and actor_grant.organization_id = current_principal.organization_id
      and (actor_grant.flow_id is null or actor_grant.flow_id = current_principal.flow_id)
      and actor_grant.state = 'active'
    order by (actor_grant.flow_id = current_principal.flow_id) desc
    limit 1
    for share of actor_grant;
    if actor_state is distinct from 'active' then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  end if;

  if not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.organization_id = current_principal.organization_id
      and organization.state = 'active'
  ) then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.expires_at is not null
    and current_principal.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  return query select 'available'::text,
    vortex_access.flow_run_as_principal_to_json_internal(current_principal);
end
$function$;

revoke all on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) to vortex_runtime;

comment on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) is
  'Runtime-only, exact-scope read of an active flow run-as principal; revoked, expired, inactive or unregistered actors return unavailable.';

commit;
