create or replace function vortex_record.pivot_dimension_internal(
  p_values jsonb[],
  p_field jsonb
)
returns table (value jsonb, normalized jsonb, sort_rank integer, sort_title text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_type_id uuid;
  title_field_id uuid;
  target_context jsonb;
  readable_ids uuid[];
  readable_titles jsonb;
begin
  if coalesce(pg_catalog.cardinality(p_values), 0) = 0 then return; end if;
  if p_field ->> 'type' <> 'link' then
    -- Choice and date values keep their canonical text order.
    return query select item.value, item.value, 0, item.value::text from pg_catalog.unnest(p_values) as item(value);
    return;
  end if;
  target_type_id := (p_field #>> '{settings,target,recordTypeId}')::uuid;
  target_context := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  title_field_id := (target_context #>> '{recordType,titleFieldId}')::uuid;
  -- One protected batch for the distinct targets, before grouping or paging. Missing, withheld
  -- and unreadable targets share one value: their identities never become separate axes.
  select coalesce(pg_catalog.array_agg(titles.record_id), array[]::uuid[]),
    coalesce(pg_catalog.jsonb_object_agg(
      titles.record_id::text, titles.result #>> array['values', title_field_id::text]
    ), '{}'::jsonb)
  into readable_ids, readable_titles
  from vortex_record.read_record_titles_internal(
    target_type_id,
    (select pg_catalog.array_agg(distinct (item.value ->> 'recordId')::uuid)
     from pg_catalog.unnest(p_values) as item(value)
     where item.value ->> 'recordTypeId' = target_type_id::text),
    title_field_id
  ) as titles
  where titles.result ->> 'outcome' = 'allowed'
    and titles.result -> 'values' ? title_field_id::text
    and nullif(titles.result #>> array['values', title_field_id::text], '') is not null;
  if target_context #>> '{recordType,systemProjection,protectedView}' = 'groups' then
    select coalesce(pg_catalog.array_agg(visible.record_id), array[]::uuid[])
    into readable_ids
    from vortex_access.list_visible_group_link_labels(readable_ids) as visible;
  end if;
  return query
    with readable as materialized (
      select distinct id from pg_catalog.unnest(readable_ids) as permitted(id)
    )
    -- Order: named targets by readable title, then Not set, then Not available last.
    select item.value, normalized.value,
      case when normalized.value = 'null'::jsonb then 1
        when normalized.value = '"not_available"'::jsonb then 2 else 0 end,
      case when normalized.value ->> 'recordId' is null then ''
        else readable_titles ->> (normalized.value ->> 'recordId') end
    from pg_catalog.unnest(p_values) as item(value)
    left join readable on readable.id = (item.value ->> 'recordId')::uuid
    cross join lateral (select case
      when item.value is null or item.value = 'null'::jsonb then 'null'::jsonb
      when item.value ->> 'recordTypeId' = target_type_id::text
        and readable.id is not null then item.value
      else '"not_available"'::jsonb end as value) as normalized;
end
$function$;

alter function vortex_record.pivot_dimension_internal(jsonb[],jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.pivot_dimension_internal(jsonb[],jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.pivot_dimension_internal(jsonb[],jsonb) to vortex_owner;

comment on function vortex_record.pivot_dimension_internal(jsonb[],jsonb) is
  'Normalizes distinct pivot dimension values through one protected target-title batch for a link and returns each value with its sort key (rank, readable title); all unreadable link targets fold into one Not available value before the summary groups and orders them.';
