create or replace function vortex_access.list_organization_groups_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
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
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  scan_sql text;
begin
  if p_sort_key not in ('record_id', 'key', 'label', 'state')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Group projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'key' then 'organization_group.group_key'
    when 'label' then 'organization_group.label'
    when 'state' then 'organization_group.state'
    else 'organization_group.group_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Group projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Group projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and organization_group.group_id > $4'
        else ' and organization_group.group_id < $4' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", organization_group.group_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end
      );
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('organization_group.group_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s, organization_group.group_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  scan_sql := $scan$
    select organization_group.organization_id,
      organization_group.group_id,
      organization_group.revision,
      pg_catalog.jsonb_build_object(
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      )
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = $1
      and ($2 is null or organization_group.group_id = any($2))
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, p_limit;
end
$function$;

create or replace function vortex_access.list_organization_groups_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_groups_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_access.list_organization_groups_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_groups_projection(uuid, integer)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_access.list_organization_groups_projection(uuid, integer) is
  'Registered group projection with the original record-id ordering and visibility; delegates to the bounded reader.';
alter function vortex_access.list_organization_groups_projection(uuid, integer)
  owner to vortex_owner;
