create or replace function vortex_connection.grant_connection_application_for_administration(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform vortex_connection.assert_human_administration_request();

  perform vortex_connection.grant_connection_application_internal(
    p_connection_instance_id,
    p_application_root_id,
    p_administrator_activity_id
  );
end
$function$;

revoke all on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid)
  to vortex_request;
comment on function vortex_connection.grant_connection_application_for_administration(uuid, uuid, uuid) is
  'Human request entry point for granting an application use of a connection instance; delegates to grant_connection_application_internal.';
