-- #842: require a connection-administration permission for connection writers,
-- close the cross-organisation existence disclosure, refuse a null expected
-- revision, record every writer in Activity, and replace direct table SELECT
-- with the scoped readers.
--
-- `vortex_connection.validated_administration_context` accepted any validated
-- member of the organisation: no connection permission was evaluated, so any
-- member's request could register, grant, mark healthy, revoke or reauthorise a
-- connection. It now evaluates the registered
-- `platform.organization.applications.manage` authority through
-- `vortex_access.evaluate_organization_permission_eligibility` for a human
-- caller and returns the same validated context. Governance for a trusted
-- system caller is unchanged.
--
-- The grant, grant-revocation, health-check, instance-revocation and
-- reauthorisation helpers locked the connection row by identifier and only then
-- checked the organisation, and the grant helpers raised different errors for a
-- missing row and a foreign-organisation row. Every writer now validates the
-- administration context before locking, then binds its row lock to the
-- resolved context organisation, so a foreign or missing identifier is
-- indistinguishable.
--
-- `p_expected_revision` was not refused when null: `revision <> null` is null,
-- so the update matched no row and the function silently returned null. Every
-- revision-checked writer now refuses a null or non-JSON-safe expected revision
-- explicitly.
--
-- Only the two grant helpers appended an Activity entry. Registration, health
-- recording, instance revocation and reauthorisation now append one entry each
-- through `append_connection_instance_activity_internal`, retaining the acting
-- organisation account or governed system actor.
--
-- The tables no longer grant direct SELECT to `vortex_request`; the scoped,
-- SECURITY DEFINER `resolve_connection_instance_readiness` and
-- `read_active_connection_evidence` readers are the only read surface. Both now
-- treat a non-finite (`infinity`) token expiry as expired, and the readiness
-- resolver returns the exact stored expiry so the TypeScript caller can refuse
-- an unreadable value.
--
-- Main rewrites several of these functions in place, so every live body is
-- patched from its current `pg_get_functiondef` with an exactly-once guard:
-- ownership, grants, comments and dependencies are untouched, and drift fails
-- the migration instead of silently editing an unexpected body. Each body is
-- re-created under its function's own current owner, as the earlier in-place
-- patches do.

begin;

set local role postgres;

create or replace function vortex_connection.assert_connection_administration_authority(
  p_context jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  operation_value constant text := 'platform.organization.connections.manage';
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from (p_context ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (p_context ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (p_context ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (p_context ->> 'correlationId')::uuid then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  end if;
end
$function$;

create or replace function vortex_connection.append_connection_instance_activity_internal(
  p_context jsonb,
  p_activity_id uuid,
  p_connection_instance_id uuid,
  p_action text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_kind text;
  actor_id uuid;
begin
  if p_context ->> 'callerKind' = 'human' then
    actor_kind := 'organization_account';
    actor_id := (p_context ->> 'organizationAccountId')::uuid;
  elsif p_context ->> 'callerKind' = 'system' then
    actor_kind := 'system';
    actor_id := (p_context ->> 'systemActorId')::uuid;
  else
    raise exception using
      errcode = '42501',
      message = 'Connection Activity requires validated human or system context';
  end if;

  perform vortex_activity.append_organization_activity_entry(
    (p_context ->> 'organizationId')::uuid,
    p_activity_id,
    p_occurred_at,
    actor_kind,
    actor_id,
    p_action,
    array[p_connection_instance_id],
    array[]::uuid[],
    'connection',
    (p_context ->> 'correlationId')::uuid,
    'completed'
  );
end
$function$;

revoke all on function
  vortex_connection.assert_connection_administration_authority(jsonb),
  vortex_connection.append_connection_instance_activity_internal(jsonb, uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

reset role;

do $migration$
declare
  targets constant jsonb := pg_catalog.jsonb_build_array(
    -- Administration context: evaluate the connection-administration
    -- permission for a human caller before returning the validated context.
    pg_catalog.jsonb_build_array(
      'vortex_connection.validated_administration_context(uuid)',
      $p$  if ctx_caller_kind = 'human' then
    ctx := vortex_access.validated_human_request_context();
  elsif ctx_caller_kind = 'system' then$p$,
      $p$  if ctx_caller_kind = 'human' then
    ctx := vortex_access.validated_human_request_context();
    perform vortex_connection.assert_connection_administration_authority(ctx);
  elsif ctx_caller_kind = 'system' then$p$
    ),

    -- Registration: capture the validated context and append its Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.register_connection_instance_internal(uuid,uuid,uuid,text,text,text,uuid,timestamptz)',
      $p$  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  -- Validate administration context for target organization
  perform vortex_connection.validated_administration_context(p_organization_id);$p$,
      $p$  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
begin
  -- Validate administration context for target organization
  administration_context := vortex_connection.validated_administration_context(p_organization_id);$p$,
      $p$    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );$p$,
      $p$    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_registered',
    operation_at
  );$p$
    ),

    -- Application grant: validate the context before locking and bind the lock
    -- to the context organisation.
    pg_catalog.jsonb_build_array(
      'vortex_connection.grant_connection_application_internal(uuid,uuid,uuid)',
      $p$  -- Lock connection instance row for share
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  -- Validate administration context for connection's organization
  administration_context := vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;$p$
    ),

    -- Application grant revocation: same lock ordering.
    pg_catalog.jsonb_build_array(
      'vortex_connection.revoke_connection_application_internal(uuid,uuid,uuid)',
      $p$  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  administration_context := vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;$p$
    ),

    -- Health check: refuse a null revision and a missing administrator, validate
    -- the context before locking, bind the lock to the organisation, and append
    -- Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.record_connection_health_check_internal(uuid,bigint,text,uuid)',
      $p$  next_state text;
  new_revision bigint;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then$p$,
      $p$  next_state text;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then$p$,
      $p$      message = 'Invalid health outcome: must be healthy or unhealthy';
  end if;

  -- Lock row for update
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;

  -- Validate context
  perform vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$      message = 'Invalid health outcome: must be healthy or unhealthy';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires a valid expected revision';
  end if;

  if p_administrator_activity_id is null
    or p_administrator_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  -- Lock row for update
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;$p$,
      $p$  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = coalesce(p_administrator_activity_id, administrator_activity_id),
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  return new_revision;$p$,
      $p$  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = p_administrator_activity_id,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_health_recorded',
    operation_at
  );

  return new_revision;$p$
    ),

    -- Instance revocation: refuse a null revision, validate before locking, bind
    -- the lock to the organisation, and append Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.revoke_connection_instance_internal(uuid,bigint,uuid)',
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires non-nil administrator activity ID';
  end if;

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection revocation failed: revision mismatch or not found';
  end if;

  perform vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires a valid expected revision';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection revocation failed: revision mismatch or not found';
  end if;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'revoked',
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  return new_revision;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'revoked',
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_revoked',
    operation_at
  );

  return new_revision;$p$
    ),

    -- Reauthorisation: refuse a null revision, validate before locking, bind the
    -- lock to the organisation, and append Activity.
    pg_catalog.jsonb_build_array(
      'vortex_connection.reauthorize_connection_instance_internal(uuid,bigint,uuid,text,timestamptz)',
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires non-nil administrator activity ID';
  end if;

  if p_destination_fingerprint is not null and p_destination_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid destination fingerprint: must be 64 lowercase hex characters';
  end if;

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection reauthorization failed: revision mismatch or not found';
  end if;

  perform vortex_connection.validated_administration_context(conn_row.organization_id);$p$,
      $p$  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires a valid expected revision';
  end if;

  if p_destination_fingerprint is not null and p_destination_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid destination fingerprint: must be 64 lowercase hex characters';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection reauthorization failed: revision mismatch or not found';
  end if;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'pending',
      last_health_outcome = 'unknown',
      destination_fingerprint = coalesce(p_destination_fingerprint, destination_fingerprint),
      token_expires_at = p_token_expires_at,
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  return new_revision;$p$,
      $p$  update vortex_connection.connection_instances
  set state = 'pending',
      last_health_outcome = 'unknown',
      destination_fingerprint = coalesce(p_destination_fingerprint, destination_fingerprint),
      token_expires_at = p_token_expires_at,
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_reauthorized',
    operation_at
  );

  return new_revision;$p$
    ),

    -- Readiness resolver: a non-finite token expiry is expired, and the exact
    -- stored expiry is returned for the TypeScript caller to validate.
    pg_catalog.jsonb_build_array(
      'vortex_connection.resolve_connection_instance_readiness(uuid,uuid,uuid,text,bigint,text)',
      $p$  if conn_row.token_expires_at is not null and conn_row.token_expires_at <= now_ts then$p$,
      $p$  if conn_row.token_expires_at is not null
    and (not pg_catalog.isfinite(conn_row.token_expires_at)
      or conn_row.token_expires_at <= now_ts) then$p$,
      $p$    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );$p$,
      $p$    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'tokenExpiresAt', pg_catalog.to_jsonb(conn_row.token_expires_at),
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );$p$
    ),

    -- Active-evidence reader: a non-finite token expiry is expired.
    pg_catalog.jsonb_build_array(
      'vortex_connection.read_active_connection_evidence(uuid)',
      $p$    and (conn.token_expires_at is null or conn.token_expires_at > pg_catalog.statement_timestamp())$p$,
      $p$    and (conn.token_expires_at is null
      or (pg_catalog.isfinite(conn.token_expires_at)
        and conn.token_expires_at > pg_catalog.statement_timestamp()))$p$
    )
  );

  target jsonb;
  procedure_id pg_catalog.regprocedure;
  patch_index integer;
  old_text text;
  new_text text;
  occurrences integer;
  definition text;
  owner_name name;
begin
  for target in
    select item.value
    from pg_catalog.jsonb_array_elements(targets) as item(value)
  loop
    procedure_id := (target ->> 0)::pg_catalog.regprocedure;
    definition := pg_catalog.pg_get_functiondef(procedure_id);
    if definition is null then
      raise exception using errcode = '55000',
        message = 'Connection administration patch target is unavailable',
        detail = procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
    patch_index := 1;
    while patch_index < pg_catalog.jsonb_array_length(target) loop
      old_text := target ->> patch_index;
      new_text := target ->> (patch_index + 1);
      occurrences := (
        pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
      ) / pg_catalog.length(old_text);
      if occurrences <> 1 then
        raise exception using errcode = '55000',
          message = 'Connection administration patch does not match exactly once',
          detail = procedure_id::text;
      end if;
      definition := pg_catalog.replace(definition, old_text, new_text);
      patch_index := patch_index + 2;
    end loop;

    -- Re-created under the function's own current owner so its grants,
    -- comment and OID stay put.
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

-- Direct table SELECT is replaced by the scoped, SECURITY DEFINER readers.
-- Applied as the table owner so the privilege change never depends on the
-- migration role.
set local role postgres;

revoke select on table vortex_connection.connection_instances
  from vortex_request;
revoke select on table vortex_connection.connection_application_grants
  from vortex_request;

drop policy if exists connection_instances_request_read
  on vortex_connection.connection_instances;
drop policy if exists connection_application_grants_request_read
  on vortex_connection.connection_application_grants;

reset role;

commit;
