create or replace function vortex_connection.read_connection_instance_for_administration(
  p_organization_id uuid,
  p_connection_instance_id uuid
)
returns table (
  organization_id uuid,
  connection_instance jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
  conn_row vortex_connection.connection_instances%rowtype;
  authorized_application_ids uuid[];
begin
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_connection_instance_id is null or p_connection_instance_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection instance read input is invalid';
  end if;

  perform vortex_connection.assert_human_administration_request();
  administration_context :=
    vortex_connection.validated_administration_context(p_organization_id);

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid;

  if not found then
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(
      grant_entry.application_root_id order by grant_entry.application_root_id
    ),
    array[]::uuid[]
  )
  into authorized_application_ids
  from vortex_connection.connection_application_grants as grant_entry
  join vortex_definition.roots as app_root
    on app_root.root_id = grant_entry.application_root_id
    and app_root.organization_id = grant_entry.organization_id
    and app_root.kind = 'application'
  where grant_entry.connection_instance_id = conn_row.connection_instance_id
    and grant_entry.organization_id = conn_row.organization_id;

  return query
  select
    conn_row.organization_id,
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'connectionInstanceId', conn_row.connection_instance_id,
        'connectionTypeId', conn_row.connection_type_id,
        'connectionTypeVersion', conn_row.connection_type_version,
        'state', conn_row.state,
        'lastHealthOutcome', conn_row.last_health_outcome,
        'revision', conn_row.revision,
        'tokenExpiresAt', case
          when conn_row.token_expires_at is null
            or not pg_catalog.isfinite(conn_row.token_expires_at)
          then null
          else pg_catalog.to_jsonb(conn_row.token_expires_at)
        end,
        'authorizedApplicationIds', pg_catalog.to_jsonb(authorized_application_ids),
        'grantedScopes', '[]'::jsonb
      )
    );
end
$function$;

revoke all on function
  vortex_connection.read_connection_instance_for_administration(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.read_connection_instance_for_administration(uuid, uuid)
to vortex_request;

comment on function
  vortex_connection.read_connection_instance_for_administration(uuid, uuid) is
  'Reads one connection instance safe status for the administration page in the request context organisation. Returns state, health, expiry, authority revision and both scope lists; never a secret, a secret reference, an organisation identity or another organisation instance.';
