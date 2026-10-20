create or replace function vortex_record.query_search_matches_internal(
  p_readable_values jsonb,
  p_search_field_ids text[],
  p_search text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_search is null or exists (
    select 1 from pg_catalog.unnest(p_search_field_ids) as field(id)
    where p_readable_values ? field.id and (
      (pg_catalog.jsonb_typeof(p_readable_values -> field.id) in ('string', 'number')
        and pg_catalog.strpos(pg_catalog.lower(p_readable_values ->> field.id), pg_catalog.lower(p_search)) > 0)
      or (pg_catalog.jsonb_typeof(p_readable_values -> field.id) = 'array' and exists (
        select 1 from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(p_readable_values -> field.id) = 'array'
          then p_readable_values -> field.id else '[]'::jsonb end) as member(value)
        where pg_catalog.jsonb_typeof(member.value) = 'string'
          and pg_catalog.strpos(pg_catalog.lower(member.value #>> '{}'), pg_catalog.lower(p_search)) > 0
      ))
    )
  );
$function$;

alter function vortex_record.query_search_matches_internal(jsonb,text[],text) owner to vortex_owner;
revoke all on function vortex_record.query_search_matches_internal(jsonb,text[],text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.query_search_matches_internal(jsonb,text[],text)
  to vortex_record_adapter;

comment on function vortex_record.query_search_matches_internal(jsonb,text[],text) is
  'One search predicate for protected list, group member and summary reads, evaluated only over currently readable scalar and choice-array values.';
