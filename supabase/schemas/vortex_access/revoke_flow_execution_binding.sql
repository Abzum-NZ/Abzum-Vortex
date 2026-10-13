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
  stored record; claimed jsonb;
  current_binding vortex_access.flow_execution_bindings%rowtype;
  stored_binding vortex_access.flow_execution_bindings%rowtype;
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_flow_execution_binding', p_duplicate_key, p_organization_id,
    authority.tenant_id, p_actor_organization_account_id, 'Flow execution binding duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_execution_binding_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow execution binding duplicate conflicts';
    end if;
    select binding.* into stored_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = stored."subjectRevisions"[1]
      and binding.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow execution binding replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json_internal(stored_binding),
      stored."receiptId",
      stored."acceptedAt";
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

  activity_result := vortex_record.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_execution_binding',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow execution binding Activity is stale';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', operation_at, 'subjectIds', pg_catalog.to_jsonb(array[p_execution_binding_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[next_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json_internal(stored_binding),
    new_receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow execution binding at its next revision; the recorded channel comes from the trusted request context.';
