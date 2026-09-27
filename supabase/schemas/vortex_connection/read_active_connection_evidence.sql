create or replace function vortex_connection.read_active_connection_evidence(
  p_connection_instance_id uuid
)
returns table (
  connection_instance_id uuid,
  destination_key text,
  destination_fingerprint text,
  organization_id uuid,
  authorized_application_ids uuid[],
  state text,
  revision bigint,
  last_health_outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_org_id uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  locked_authorized_application_ids uuid[];
begin
  context_org_id := vortex_context.organization_id();

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = context_org_id
    and conn.state = 'active'
    and conn.last_health_outcome = 'healthy'
    and (conn.token_expires_at is null
      or (pg_catalog.isfinite(conn.token_expires_at)
        and conn.token_expires_at > pg_catalog.statement_timestamp()))
  for share;

  if not found then
    return;
  end if;

  select pg_catalog.array_agg(
    locked_grant.application_root_id order by locked_grant.application_root_id
  )
  into locked_authorized_application_ids
  from (
    select grant_entry.application_root_id
    from vortex_connection.connection_application_grants as grant_entry
    join vortex_definition.roots as app_root
      on app_root.root_id = grant_entry.application_root_id
      and app_root.organization_id = grant_entry.organization_id
      and app_root.kind = 'application'
    where grant_entry.connection_instance_id = conn_row.connection_instance_id
      and grant_entry.organization_id = conn_row.organization_id
    for share of grant_entry, app_root
  ) as locked_grant;

  if locked_authorized_application_ids is null then
    return;
  end if;

  return query
  select
    conn_row.connection_instance_id,
    conn_row.destination_key,
    conn_row.destination_fingerprint,
    conn_row.organization_id,
    locked_authorized_application_ids,
    conn_row.state,
    conn_row.revision,
    conn_row.last_health_outcome;
end
$function$;

comment on function vortex_connection.read_active_connection_evidence(uuid) is
  '#408: Reads active healthy Connection instance evidence scoped to current context organization.';

revoke all on function
  vortex_connection.read_active_connection_evidence(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.read_active_connection_evidence(uuid) to vortex_request, vortex_runtime;
