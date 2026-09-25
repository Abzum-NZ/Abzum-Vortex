create or replace function vortex_connection.register_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.register_connection_instance_internal(
    p_connection_instance_id,
    vortex_context.organization_id(),
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    p_administrator_activity_id,
    p_token_expires_at
  );

  return 1;
end
$function$;

revoke all on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz)
  to vortex_request;
comment on function vortex_connection.register_connection_instance_for_administration(uuid, uuid, text, text, text, uuid, timestamptz) is
  'Human request entry point for registering a connection instance in the request context organisation; delegates to register_connection_instance_internal and returns the new revision.';
