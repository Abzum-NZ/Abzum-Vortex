create or replace function vortex_connection.reauthorize_connection_instance_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid,
  p_destination_fingerprint text default null,
  p_token_expires_at timestamptz default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
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
  end if;

  if conn_row.state <> 'revoked' then
    raise exception using
      errcode = '23514',
      message = 'Connection reauthorization requires revoked source state';
  end if;

  update vortex_connection.connection_instances
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

  return new_revision;
end
$function$;

comment on function vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamp with time zone) is null;

revoke all on function
  vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamptz) to vortex_runtime;
alter function vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamp with time zone) owner to vortex_connection_owner;
