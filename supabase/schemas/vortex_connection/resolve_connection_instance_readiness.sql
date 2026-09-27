create or replace function vortex_connection.resolve_connection_instance_readiness(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_connection_instance_id uuid,
  p_destination_key text,
  p_expected_revision bigint,
  p_expected_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_org_id uuid;
  context_app_id uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  now_ts timestamptz := pg_catalog.statement_timestamp();
begin
  -- 1. Validate parameter shapes (all mandatory)
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_connection_instance_id is null or p_connection_instance_id = nil_uuid
    or p_application_root_id is null or p_application_root_id = nil_uuid
    or p_destination_key is null
    or pg_catalog.char_length(p_destination_key) not between 1 and 80
    or p_destination_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_expected_fingerprint is null
    or p_expected_fingerprint !~ '^[a-f0-9]{64}$' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_parameters'
    );
  end if;

  -- 2. Validate request context binding
  context_value := vortex_context.current_context();
  context_org_id := vortex_context.organization_id();
  if context_org_id is null or context_org_id <> p_organization_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'organization_mismatch'
    );
  end if;

  -- Connection instances strictly require permanent application scope (not organisation-shared)
  if context_value ? 'applicationRootId' then
    context_app_id := (context_value ->> 'applicationRootId')::uuid;
    if context_app_id is distinct from p_application_root_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused',
        'reasonCode', 'application_mismatch'
      );
    end if;
  end if;

  -- 3. Read connection instance row under FOR SHARE lock
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = p_organization_id
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_unavailable'
    );
  end if;

  -- 4. Check active state and health outcome
  if conn_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_not_active',
      'currentState', conn_row.state
    );
  end if;

  if conn_row.last_health_outcome <> 'healthy' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_unhealthy',
      'currentHealthOutcome', conn_row.last_health_outcome
    );
  end if;

  -- 5. Check token expiry if set
  if conn_row.token_expires_at is not null
    and (not pg_catalog.isfinite(conn_row.token_expires_at)
      or conn_row.token_expires_at <= now_ts) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_token_expired'
    );
  end if;

  -- 6. Check destination key
  if conn_row.destination_key <> p_destination_key then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'destination_mismatch'
    );
  end if;

  -- 7. Mandatory revision freshness check
  if conn_row.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_revision',
      'currentRevision', conn_row.revision
    );
  end if;

  -- 8. Mandatory destination fingerprint freshness check
  if conn_row.destination_fingerprint <> p_expected_fingerprint then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_fingerprint'
    );
  end if;

  -- 9. Lock the exact application grant and its permanent root for the decision.
  perform 1
  from vortex_connection.connection_application_grants as grant_entry
  join vortex_definition.roots as app_root
    on app_root.root_id = grant_entry.application_root_id
    and app_root.organization_id = grant_entry.organization_id
    and app_root.kind = 'application'
  where grant_entry.connection_instance_id = p_connection_instance_id
    and grant_entry.application_root_id = p_application_root_id
    and grant_entry.organization_id = p_organization_id
  for share of grant_entry, app_root;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'grant_unauthorized'
    );
  end if;

  -- 10. Return authoritative owner-projected readiness evidence
  return pg_catalog.jsonb_build_object(
    'outcome', 'ready',
    'connectionInstanceId', conn_row.connection_instance_id,
    'organizationId', conn_row.organization_id,
    'applicationRootId', p_application_root_id,
    'destinationKey', conn_row.destination_key,
    'destinationFingerprint', conn_row.destination_fingerprint,
    'revision', conn_row.revision,
    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'tokenExpiresAt', pg_catalog.to_jsonb(conn_row.token_expires_at),
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );
end
$function$;

comment on function vortex_connection.resolve_connection_instance_readiness(
  uuid, uuid, uuid, text, bigint, text
) is
  '#408: Authoritative owner-projected Connection-instance readiness resolver. Fails closed on inactive, unhealthy, expired, mismatched destination, ungranted application, or stale revision/fingerprint.';

revoke all on function
  vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text) to vortex_request, vortex_runtime;

grant execute on function vortex_connection.resolve_connection_instance_readiness(
  uuid, uuid, uuid, text, bigint, text
) to vortex_record_owner;
