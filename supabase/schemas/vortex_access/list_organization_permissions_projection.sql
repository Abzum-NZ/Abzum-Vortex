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
  after_sort_key text;
  record_id_sql text := 'vortex_access.permission_projection_record_id('
    || 'entry.organization_id, entry.registration_kind, entry.registration_owner_id, '
    || 'entry.owner_kind, entry.owner_id, entry.permission_id)';
  keyset_sql text := '';
  sort_sql text;
  outer_sort_sql text;
  sort_bind_sql text;
  direction_sql text;
  scan_sql text;
begin
  if p_sort_key is null or p_sort_key not in ('record_id', 'key', 'label', 'administrative')
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Permission projection bounds are invalid';
  end if;
  sort_sql := case p_sort_key
    when 'key' then 'entry.permission_key'
    when 'label' then 'entry.label'
    when 'administrative' then 'entry.administrative'
    else record_id_sql end;
  outer_sort_sql := case p_sort_key
    when 'key' then 'entry.permission_key'
    when 'label' then 'entry.label'
    when 'administrative' then 'entry.administrative'
    else 'entry.projected_record_id' end;
  sort_bind_sql := case when p_sort_key = 'administrative' then '$5::boolean' else '$5' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_sort_key := p_after -> 'sortKey' ->> 0;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end;
    if p_sort_key = 'administrative' and after_sort_key not in ('true', 'false') then
      raise exception using errcode = '22023', message = 'Permission projection cursor is invalid';
    end if;
    keyset_sql := case when p_sort_key = 'record_id' then pg_catalog.format(
      ' and %s %s $3', record_id_sql,
      case when p_direction = 'ascending' then '>' else '<' end
    ) else pg_catalog.format(
      ' and (%s, %s) %s (%s, $3)', sort_sql, record_id_sql,
      case when p_direction = 'ascending' then '>' else '<' end,
      sort_bind_sql
    ) end;
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
    ' order by %s %s, %s %s limit $4) as entry '
      || 'where registration.organization_id = $1 and registration.state = ''active'' '
      || 'order by %s %s, entry.projected_record_id %s limit $4',
    sort_sql, direction_sql, record_id_sql, direction_sql,
    outer_sort_sql, direction_sql, direction_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_record_id, p_limit, after_sort_key;
end
$function$;

revoke all on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_permissions_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;
