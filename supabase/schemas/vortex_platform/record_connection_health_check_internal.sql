create or replace function vortex_platform.record_connection_health_check_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_administrator_activity_id uuid default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  conn_row vortex_platform.connection_instances%rowtype;
  next_state text;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then
    raise exception using
      errcode = '22023',
      message = 'Invalid health outcome: must be healthy or unhealthy';
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
  administration_context := vortex_platform.validated_administration_context(vortex_platform.organization_id());

  -- Lock row for update
  select conn.* into conn_row
  from vortex_platform.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;

  -- Terminal revocation check
  if conn_row.state = 'revoked' then
    raise exception using
      errcode = '42501',
      message = 'Connection instance is revoked; revocation is terminal and cannot transition via health check';
  end if;

  -- Explicit monotonic state transition matrix
  if p_new_health_outcome = 'healthy' then
    next_state := 'active';
  else
    next_state := 'unhealthy';
  end if;

  update vortex_platform.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = p_administrator_activity_id,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_platform.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_health_recorded',
    operation_at
  );

  return new_revision;
end
$function$;

comment on function vortex_platform.record_connection_health_check_internal(uuid, bigint, text, uuid) is null;

revoke all on function
  vortex_platform.record_connection_health_check_internal(uuid, bigint, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_platform.record_connection_health_check_internal(uuid, bigint, text, uuid) to vortex_runtime;
alter function vortex_platform.record_connection_health_check_internal(uuid, bigint, text, uuid) owner to vortex_owner;
