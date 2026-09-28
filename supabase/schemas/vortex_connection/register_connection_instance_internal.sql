create or replace function vortex_connection.register_connection_instance_internal(
  p_connection_instance_id uuid,
  p_organization_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
begin
  -- Validate administration context for target organization
  administration_context := vortex_connection.validated_administration_context(p_organization_id);

  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection registration requires non-nil administrator activity ID';
  end if;

  insert into vortex_connection.connection_instances (
    connection_instance_id,
    organization_id,
    connection_type_id,
    connection_type_version,
    destination_key,
    destination_fingerprint,
    state,
    last_health_outcome,
    revision,
    administrator_activity_id,
    token_expires_at,
    created_at,
    updated_at
  ) values (
    p_connection_instance_id,
    p_organization_id,
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    'pending',
    'unknown',
    1,
    p_administrator_activity_id,
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
  );
end
$function$;

alter function vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamp with time zone) owner to vortex_connection_owner;

comment on function vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamp with time zone) is null;

revoke all on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamptz) to vortex_runtime;
