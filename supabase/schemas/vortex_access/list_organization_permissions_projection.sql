create or replace function vortex_access.list_organization_permissions_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  after_record_id uuid;
  record_id_sql text := 'vortex_access.permission_projection_record_id('
    || 'entry.organization_id, entry.registration_kind, entry.registration_owner_id, '
    || 'entry.owner_kind, entry.owner_id, entry.permission_id)';
  keyset_sql text := '';
  scan_sql text;
begin
  if p_sort_key is distinct from 'record_id'
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Permission projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end;
    keyset_sql := pg_catalog.format(' and %s %s $3', record_id_sql,
      case when p_direction = 'ascending' then '>' else '<' end);
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_permissions_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  scan_sql := $scan$
    select entry.organization_id,
      entry.projected_record_id,
      entry.registration_revision,
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'label', entry.label,
        'description', entry.description,
        'owner_kind', entry.owner_kind,
        'action_kind', entry.action_kind,
        'named_action', entry.named_action,
        'administrative', entry.administrative
      )
    from vortex_access.permission_registrations as registration
    cross join lateral (
      select entry.*,
        vortex_access.permission_projection_record_id(
          entry.organization_id, entry.registration_kind, entry.registration_owner_id,
          entry.owner_kind, entry.owner_id, entry.permission_id
        ) as projected_record_id
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = registration.organization_id
        and entry.registration_kind = registration.registration_kind
        and entry.registration_owner_id = registration.registration_owner_id
        and entry.registration_revision = registration.revision
        and ($2 is null or vortex_access.permission_projection_record_id(
          entry.organization_id, entry.registration_kind, entry.registration_owner_id,
          entry.owner_kind, entry.owner_id, entry.permission_id
        ) = any($2))
  $scan$ || keyset_sql || pg_catalog.format(
    ' order by %s %s limit $4) as entry '
      || 'where registration.organization_id = $1 and registration.state = ''active'' '
      || 'order by entry.projected_record_id %s limit $4',
    record_id_sql, case when p_direction = 'ascending' then 'asc' else 'desc' end,
    case when p_direction = 'ascending' then 'asc' else 'desc' end);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, p_limit;
end
$function$;

create or replace function vortex_access.list_organization_permissions_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_permissions_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;


revoke all on function vortex_access.list_organization_permissions_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_permissions_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_permissions_projection(uuid, integer) is
  'Registered permission projection with the original record-id ordering and visibility; delegates to the bounded reader.';

alter function vortex_access.list_organization_permissions_projection(uuid, integer)
  owner to vortex_owner;
