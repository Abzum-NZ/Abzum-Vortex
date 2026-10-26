create or replace function vortex_access.list_organization_groups_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer,
  p_predicate jsonb
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
  predicate_plan jsonb;
  context_value jsonb;
  visible_organization_id uuid;
  names_only boolean := false;
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

  -- A viewer the groups administration scope admits sees every group of the organisation. Any
  -- other viewer whose human request context is live sees only the names of the organisation's
  -- active groups, the group chooser's choices: no key or state, and only the name to filter,
  -- search or sort by. A viewer neither rule admits sees no rows.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
    visible_organization_id := scope_row.organization_id;
  exception when insufficient_privilege then
    visible_organization_id := null;
  end;
  if visible_organization_id is null then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception when insufficient_privilege then
      return;
    end;
    visible_organization_id := (context_value ->> 'organizationId')::uuid;
    names_only := true;
    if p_sort_key in ('key', 'state') then
      return;
    end if;
  end if;

  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    case when names_only then
      $names${
        "label": {"sql": "organization_group.label", "database": "text", "filter": true, "search": true}
      }$names$::jsonb
    else
      $declared${
        "state": {"sql": "organization_group.state", "database": "text", "filter": true},
        "key": {"sql": "organization_group.group_key", "database": "text", "search": true},
        "label": {"sql": "organization_group.label", "database": "text", "filter": true, "search": true}
      }$declared$::jsonb
    end,
    6
  );
  scan_sql := $scan$
    select organization_group.organization_id,
      organization_group.group_id,
      organization_group.revision,
      case when $7 then pg_catalog.jsonb_build_object('label', organization_group.label)
      else pg_catalog.jsonb_build_object(
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      ) end
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = $1
      and ($2 is null or organization_group.group_id = any($2))
      and (not $7 or organization_group.state = 'active')
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    after_value, after_record_id, p_limit, predicate_plan -> 'parameters', names_only;
end
$function$;

revoke all on function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_groups_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;
