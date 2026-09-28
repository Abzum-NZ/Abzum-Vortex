create or replace function vortex_connection.grant_connection_application_internal(
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
  app_org_id uuid;
  app_kind text;
  administration_context jsonb;
  inserted_connection_instance_id uuid;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection grant requires non-nil administrator activity ID';
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

  -- Resolve and lock application root
  select root.organization_id, root.kind into app_org_id, app_kind
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root is unavailable';
  end if;

  if app_kind <> 'application' then
    raise exception using
      errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if app_org_id <> conn_row.organization_id then
    raise exception using
      errcode = '23514',
      message = 'Referenced application root organization does not match connection organization';
  end if;

  insert into vortex_connection.connection_application_grants (
    connection_instance_id,
    application_root_id,
    organization_id,
    granted_at
  ) values (
    p_connection_instance_id,
    p_application_root_id,
    conn_row.organization_id,
    operation_at
  )
  on conflict (connection_instance_id, application_root_id) do nothing
  returning connection_instance_id into inserted_connection_instance_id;

  if inserted_connection_instance_id is null then
    raise exception using
      errcode = '23514',
      message = 'Connection application grant already exists';
  end if;

  perform vortex_connection.append_application_grant_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    p_application_root_id,
    'connection_application_granted',
    operation_at
  );
end
$function$;

comment on function vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) is null;

revoke all on function
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) to vortex_runtime;

grant execute on function vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) to vortex_connection_owner;
