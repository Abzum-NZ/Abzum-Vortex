create or replace function vortex_platform.grid_view_document_valid_internal(
  p_document jsonb,
  p_kind text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_document is not null
    and pg_catalog.jsonb_typeof(p_document) = 'object'
    and pg_catalog.octet_length(p_document::text) <= 32768
    -- A current layout holds the arrangement only; a named view adds the query state.
    and not exists (
      select 1 from pg_catalog.jsonb_object_keys(p_document) as supplied(key)
      where supplied.key <> all (case p_kind
        when 'current_layout' then array['columns', 'density']
        else array['columns', 'density', 'sort', 'filters', 'search'] end)
    )
    and pg_catalog.jsonb_typeof(p_document -> 'columns') = 'array'
    and pg_catalog.jsonb_array_length(p_document -> 'columns') between 1 and 200
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value)
      where pg_catalog.jsonb_typeof(entry.value) <> 'object'
        or entry.value - array['fieldId', 'visible', 'width'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
        or pg_catalog.jsonb_typeof(entry.value -> 'visible') is distinct from 'boolean'
        or (entry.value ? 'width' and case
          when pg_catalog.jsonb_typeof(entry.value -> 'width') = 'number' then
            (entry.value ->> 'width')::numeric not between 64 and 640
            or (entry.value ->> 'width')::numeric <> pg_catalog.trunc((entry.value ->> 'width')::numeric)
          else true end)
    )
    and exists (
      select 1 from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value)
      where entry.value -> 'visible' = 'true'::jsonb
    )
    and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
      from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value))
      = pg_catalog.jsonb_array_length(p_document -> 'columns')
    and (not p_document ? 'density' or (
      pg_catalog.jsonb_typeof(p_document -> 'density') = 'string'
      and p_document ->> 'density' in ('compact', 'comfortable')))
    and (not p_document ? 'sort' or (
      pg_catalog.jsonb_typeof(p_document -> 'sort') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'sort') between 1 and 20
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'sort') as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or entry.value - array['fieldId', 'direction'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
          or coalesce(entry.value ->> 'direction' <> all (array['ascending', 'descending']), true)
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
        from pg_catalog.jsonb_array_elements(p_document -> 'sort') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'sort')))
    and (not p_document ? 'filters' or (
      pg_catalog.jsonb_typeof(p_document -> 'filters') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'filters') between 1 and 50
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'filters') as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or entry.value - array['fieldId', 'filter'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
          or pg_catalog.jsonb_typeof(entry.value -> 'filter') is distinct from 'string'
          or pg_catalog.char_length(entry.value ->> 'filter') not between 1 and 4000
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
        from pg_catalog.jsonb_array_elements(p_document -> 'filters') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'filters')))
    and (not p_document ? 'search' or (
      pg_catalog.jsonb_typeof(p_document -> 'search') = 'string'
      and pg_catalog.char_length(p_document ->> 'search') between 1 and 200))
$function$;

revoke all on function vortex_platform.grid_view_document_valid_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_document_valid_internal(jsonb, text) is
  'Whether a grid view document holds only the arrangement and, for a named view, the query state the platform stores; owner-only.';

alter function vortex_platform.grid_view_document_valid_internal(jsonb, text) owner to vortex_owner;
