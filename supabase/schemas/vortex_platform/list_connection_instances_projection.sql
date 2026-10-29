create or replace function vortex_platform.list_connection_instances_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)
language plpgsql volatile security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  sort_column text;
  order_sql text;
  keyset_sql text := '';
  after_value text;
  after_record_id uuid;
  predicate_plan jsonb;
begin
  if p_sort_key is null or p_sort_key not in ('record_id', 'destination_key', 'state')
    or p_direction is null or p_direction not in ('ascending', 'descending')
    or (p_limit is not null and p_limit not between 1 and 500)
    or (p_limit is null and (p_record_ids is null or cardinality(p_record_ids) > 500)) then
    raise exception using errcode = '22023', message = 'Connection projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Connection projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Connection projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
  end if;
  context_value := vortex_access.validated_human_request_context();
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  perform vortex_platform.assert_connection_administration_authority(context_value);

  sort_column := case p_sort_key
    when 'destination_key' then 'conn.destination_key'
    when 'state' then 'conn.state'
    else 'conn.connection_instance_id' end;
  if p_after is not null then
    keyset_sql := case when p_sort_key = 'record_id' then
      pg_catalog.format(' and conn.connection_instance_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end)
    else pg_catalog.format(' and (%s collate "C", conn.connection_instance_id) %s ($3 collate "C", $4)',
      sort_column, case when p_direction = 'ascending' then '>' else '<' end) end;
  end if;
  order_sql := case when p_sort_key = 'record_id' then
    pg_catalog.format('conn.connection_instance_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
  else pg_catalog.format('%1$s collate "C" %2$s, conn.connection_instance_id %2$s',
    sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  predicate_plan := vortex_record.compile_projection_predicate_internal(p_predicate,
    $declared${
      "destination_key": {"sql": "conn.destination_key", "database": "text", "filter": true, "search": true},
      "state": {"sql": "conn.state", "database": "text", "filter": true}
    }$declared$::jsonb, 6);
  return query execute $scan$
    select conn.organization_id, conn.connection_instance_id, conn.revision,
      pg_catalog.jsonb_build_object(
        'destination_key', conn.destination_key,
        'connection_type_id', conn.connection_type_id,
        'connection_type_version', conn.connection_type_version,
        'state', conn.state,
        'secret_set', exists (select 1 from vortex_platform.connection_secret_references as reference
          where reference.organization_id = conn.organization_id
            and reference.connection_instance_id = conn.connection_instance_id
            and reference.vault_secret_id is not null),
        'last_health_outcome', conn.last_health_outcome,
        'token_expires_at', conn.token_expires_at
      )
    from vortex_platform.connection_instances as conn
    where conn.organization_id = $1
      and ($2 is null or conn.connection_instance_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql
    || pg_catalog.format(' order by %s limit $5', order_sql)
  using visible_organization_id, p_record_ids, after_value, after_record_id,
    coalesce(p_limit, 500), predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_platform.list_connection_instances_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.list_connection_instances_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_platform.list_connection_instances_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;
