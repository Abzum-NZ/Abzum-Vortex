create or replace function vortex_connection.record_connection_health_check_for_administration(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  return vortex_connection.record_connection_health_check_internal(
    p_connection_instance_id,
    p_expected_revision,
    p_new_health_outcome,
    p_administrator_activity_id
  );
end
$function$;

revoke all on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid)
  to vortex_request;
comment on function vortex_connection.record_connection_health_check_for_administration(uuid, bigint, text, uuid) is
  'Human request entry point for recording a revision-checked connection health outcome; delegates to record_connection_health_check_internal.';
