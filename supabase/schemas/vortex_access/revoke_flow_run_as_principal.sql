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
  stored record; claimed jsonb;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
  operation_at timestamptz;
  new_receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
begin
  if p_actor_identity_id is null or not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_platform.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_platform.is_non_nil_uuid(p_activity_id::text) then
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_flow_run_as_principal', p_duplicate_key, p_organization_id,
    authority.tenant_id, p_actor_organization_account_id, 'Flow run-as principal duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_execution_binding_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow run-as principal duplicate conflicts';
    end if;
    select principal.* into stored_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = stored."subjectRevisions"[1]
      and principal.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow run-as principal replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      stored."receiptId",
      stored."acceptedAt";
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

  activity_result := vortex_record.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_run_as_principal',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow run-as principal Activity is stale';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', operation_at, 'subjectIds', pg_catalog.to_jsonb(array[p_execution_binding_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[next_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    new_receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow run-as principal at its next revision under the existing execution-binding administration authority.';

alter function vortex_access.revoke_flow_run_as_principal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_expected_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revoke_flow_run_as_principal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_duplicate_key uuid, p_execution_binding_id uuid, p_organization_id uuid, p_expected_revision bigint, p_activity_id uuid) to postgres;
