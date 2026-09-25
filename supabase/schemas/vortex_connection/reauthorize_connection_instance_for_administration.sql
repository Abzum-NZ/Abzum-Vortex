create or replace function vortex_connection.reauthorize_connection_instance_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid,
  p_destination_fingerprint text,
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

  return vortex_connection.reauthorize_connection_instance_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_administrator_activity_id,
    p_destination_fingerprint,
    p_token_expires_at
  );
end
$function$;

revoke all on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz)
  to vortex_request;
comment on function vortex_connection.reauthorize_connection_instance_for_administration(uuid, bigint, uuid, text, timestamptz) is
  'Human request entry point for a revision-checked credential rotation or reauthorisation; delegates to reauthorize_connection_instance_internal.';
