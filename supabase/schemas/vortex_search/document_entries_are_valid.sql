create or replace function vortex_search.document_entries_are_valid(p_entries jsonb)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_entries) <> 'array' then false
    else pg_catalog.jsonb_array_length(p_entries) <= 100
      and pg_catalog.pg_column_size(p_entries) <= 262144
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or not (entry.value ?& array['fieldId', 'priority', 'weight', 'text'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entry.value)) <> 4
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') <> 'string'
          or (entry.value ->> 'fieldId') !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or pg_catalog.jsonb_typeof(entry.value -> 'priority') <> 'string'
          or pg_catalog.jsonb_typeof(entry.value -> 'weight') <> 'number'
          or pg_catalog.jsonb_typeof(entry.value -> 'text') <> 'string'
          or pg_catalog.length(entry.value ->> 'text') not between 1 and 4000
      )
      and (
        select pg_catalog.count(distinct entry.value ->> 'fieldId') = pg_catalog.count(*)
          and coalesce(pg_catalog.sum(pg_catalog.length(entry.value ->> 'text')), 0) <= 20000
        from pg_catalog.jsonb_array_elements(p_entries) as entry(value)
      )
  end;
$function$;

revoke all on function vortex_search.document_entries_are_valid(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_search.document_entries_are_valid(jsonb) is
  'Storage check for search document entries: bounded array of unique field entries with the exact entry shape, types and text sizes; ranking weights are derived by the runtime producer.';
