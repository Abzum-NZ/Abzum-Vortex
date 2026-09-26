-- #1258: protected connection instance reader for the administration page.
--
-- The #692/#693 administration page needs the safe status of a connection
-- instance - state, health, expiry, authority revision and both scope lists -
-- to compose its page, but the authoritative tables grant no direct read to a
-- request and no reader existed that tolerated a pending, unhealthy, revoked or
-- grant-less instance. `read_active_connection_evidence` only returns an active
-- healthy instance with at least one grant, and `resolve_connection_instance_readiness`
-- is a fail-closed readiness proof rather than a status reader.
--
-- This migration adds two SECURITY DEFINER readers callable only by a human
-- request: one reads a single instance by identifier, the other reads a bounded
-- page for the caller's organisation. Both require the validated connection
-- administration context, so the caller must hold
-- `platform.organization.connections.manage` in the request-context
-- organisation, and every row is filtered to that organisation. Neither returns
-- a secret value, a secret reference, an organisation identity or an
-- administrator activity identity. Authorised applications come from the grant
-- table and may be empty; granted scopes are not stored yet, so the read model
-- reports none rather than refusing a grant-less instance. The page read model
-- is split from `connectionInstanceSchema` in the contract for exactly that
-- reason: a grant-less instance is shown as such.
--
-- These are new functions with complete bodies. Every existing function, table
-- and grant is unchanged.
--
-- The canonical sources are
-- supabase/schemas/vortex_connection/read_connection_instance_for_administration.sql and
-- supabase/schemas/vortex_connection/list_connection_instances_for_administration.sql;
-- their definitions are carried here identically.

begin;

set local role postgres;

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

create or replace function vortex_connection.list_connection_instances_for_administration(
  p_organization_id uuid,
  p_after_connection_instance_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  connection_instances jsonb,
  next_after_connection_instance_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
  page_items jsonb;
  page_connection_instance_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_after_connection_instance_id = nil_uuid
    or p_page_size is null or p_page_size not between 1 and 100 then
    raise exception using
      errcode = '22023',
      message = 'Connection instance page input is invalid';
  end if;

  perform vortex_connection.assert_human_administration_request();
  administration_context :=
    vortex_connection.validated_administration_context(p_organization_id);

  with candidates as (
    select
      conn.connection_instance_id,
      conn.connection_type_id,
      conn.connection_type_version,
      conn.state,
      conn.last_health_outcome,
      conn.revision,
      conn.token_expires_at,
      coalesce(
        (
          select pg_catalog.array_agg(
            grant_entry.application_root_id order by grant_entry.application_root_id
          )
          from vortex_connection.connection_application_grants as grant_entry
          join vortex_definition.roots as app_root
            on app_root.root_id = grant_entry.application_root_id
            and app_root.organization_id = grant_entry.organization_id
            and app_root.kind = 'application'
          where grant_entry.connection_instance_id = conn.connection_instance_id
            and grant_entry.organization_id = conn.organization_id
        ),
        array[]::uuid[]
      ) as authorized_application_ids,
      pg_catalog.row_number() over (order by conn.connection_instance_id) as ordinal
    from vortex_connection.connection_instances as conn
    where conn.organization_id = (administration_context ->> 'organizationId')::uuid
      and (p_after_connection_instance_id is null
        or conn.connection_instance_id > p_after_connection_instance_id)
    order by conn.connection_instance_id
    limit p_page_size + 1
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'connectionInstanceId', candidate.connection_instance_id,
            'connectionTypeId', candidate.connection_type_id,
            'connectionTypeVersion', candidate.connection_type_version,
            'state', candidate.state,
            'lastHealthOutcome', candidate.last_health_outcome,
            'revision', candidate.revision,
            'tokenExpiresAt', case
              when candidate.token_expires_at is null
                or not pg_catalog.isfinite(candidate.token_expires_at)
              then null
              else pg_catalog.to_jsonb(candidate.token_expires_at)
            end,
            'authorizedApplicationIds',
              pg_catalog.to_jsonb(candidate.authorized_application_ids),
            'grantedScopes', '[]'::jsonb
          )
        ) order by candidate.connection_instance_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.connection_instance_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into page_items, page_connection_instance_ids, candidate_count
  from candidates as candidate;

  return query
  select
    (administration_context ->> 'organizationId')::uuid,
    page_items,
    case when candidate_count > p_page_size
      then page_connection_instance_ids[p_page_size] else null end;
end
$function$;

revoke all on function
  vortex_connection.list_connection_instances_for_administration(uuid, uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.list_connection_instances_for_administration(uuid, uuid, integer)
to vortex_request;

comment on function
  vortex_connection.list_connection_instances_for_administration(uuid, uuid, integer) is
  'Reads one bounded page of connection instance safe statuses for the administration page in the request context organisation. Returns state, health, expiry, authority revision and both scope lists per instance; never a secret, a secret reference, an organisation identity or another organisation instance.';

reset role;

commit;
