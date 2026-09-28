create or replace function vortex_connection.revoke_connection_application_internal(
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
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  administration_context jsonb;
  locked_application_root_id uuid;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection grant revocation requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
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
  end if;

  select grant_entry.application_root_id into locked_application_root_id
  from vortex_connection.connection_application_grants as grant_entry
  where grant_entry.connection_instance_id = p_connection_instance_id
    and grant_entry.application_root_id = p_application_root_id
    and grant_entry.organization_id = conn_row.organization_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection application grant not found';
  end if;

  delete from vortex_connection.connection_application_grants
  where connection_instance_id = p_connection_instance_id
    and application_root_id = locked_application_root_id;

  perform vortex_connection.append_application_grant_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    p_application_root_id,
    'connection_application_revoked',
    operation_at
  );
end
$function$;

alter function vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) owner to vortex_connection_owner;

comment on function vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) is null;

revoke all on function
  vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) to vortex_runtime;
