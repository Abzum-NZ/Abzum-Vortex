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
