create or replace function vortex_record.search_document_page(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_record_type_id uuid,
  p_fields jsonb,
  p_title_field_id uuid,
  p_terms jsonb,
  p_filters jsonb,
  p_after_score integer default null,
  p_after_record_id uuid default null,
  p_limit integer default 40
)
returns table (record_id uuid, score integer, record jsonb, capabilities jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or p_record_type_id is null or p_title_field_id is null then
    raise exception using errcode = '42501', message = 'Search scope is unavailable';
  end if;
  if pg_catalog.jsonb_typeof(p_fields) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_terms) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_filters) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_fields) > 200
    or pg_catalog.jsonb_array_length(p_terms) > 32
    or pg_catalog.jsonb_array_length(p_filters) > 32
    or (p_after_score is null) <> (p_after_record_id is null)
    or p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Search page selector is invalid';
  end if;

  return query
  with candidates as materialized (
    select d.record_id, d.source_record_version, d.entries,
      vortex_record.read_record(p_record_type_id, d.record_id) as current_read
    from vortex_record.documents d
    where d.organization_id = p_organization_id
      and (d.application_root_id = p_application_root_id or d.application_root_id is null)
      and d.record_type_id = p_record_type_id and not d.deleted
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_terms) term(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(term.value -> 'tokens') required(token)
        where not (term.value ->> 'excluded')::boolean
          and not exists (
            select 1 from pg_catalog.jsonb_array_elements(d.entries) entry(value)
            where required.token = any (pg_catalog.regexp_split_to_array(
              pg_catalog.lower(entry.value ->> 'text'),
              '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'))
          )
      )
  ), readable as materialized (
    select c.* from candidates c
    where c.current_read -> 'record' ->> 'outcome' = 'allowed'
      and (c.current_read -> 'record' ->> 'concurrencyNumber')::bigint = c.source_record_version
      and c.current_read -> 'record' -> 'values' ? p_title_field_id::text
      and c.current_read -> 'record' -> 'values' -> p_title_field_id::text <> 'null'::jsonb
      and c.current_read -> 'record' -> 'values' -> p_title_field_id::text <> '""'::jsonb
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_filters) f(value)
        where not (c.current_read -> 'record' -> 'values' ? (f.value ->> 'fieldId'))
          or not vortex_access.evaluate_typed_condition_node_internal(
            f.value -> 'condition',
            pg_catalog.jsonb_build_object(f.value ->> 'fieldId', f.value ->> 'type'),
            pg_catalog.jsonb_build_object(f.value ->> 'fieldId',
              c.current_read -> 'record' -> 'values' -> (f.value ->> 'fieldId')),
            '{}'::jsonb, '{}'::jsonb, false)
      )
  ), hits as materialized (
    select r.record_id, r.current_read, t.ordinality as term_index,
      coalesce((t.value ->> 'excluded')::boolean, false) as excluded,
      coalesce(pg_catalog.sum(case f.value ->> 'priority'
        when 'first' then 3 when 'normal' then 2 when 'last' then 1 else 0 end), 0)::integer as weight
    from readable r
    cross join pg_catalog.jsonb_array_elements(p_terms) with ordinality t(value, ordinality)
    left join lateral (
      select distinct e.value ->> 'fieldId' as field_id
      from pg_catalog.jsonb_array_elements(r.entries) e(value)
      cross join lateral (
        select pg_catalog.regexp_split_to_array(pg_catalog.lower(e.value ->> 'text'),
          '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+') as words,
          array(select pg_catalog.jsonb_array_elements_text(t.value -> 'tokens')) as term_words
      ) tokenized
      where r.current_read -> 'record' -> 'values' ? (e.value ->> 'fieldId')
        and exists (select 1 from pg_catalog.generate_series(1,
          pg_catalog.cardinality(tokenized.words) - pg_catalog.cardinality(tokenized.term_words) + 1) n
          where tokenized.words[n:n + pg_catalog.cardinality(tokenized.term_words) - 1] = tokenized.term_words)
    ) matched on true
    left join pg_catalog.jsonb_array_elements(p_fields) f(value)
      on pg_catalog.lower(f.value ->> 'fieldId') = pg_catalog.lower(matched.field_id)
    group by r.record_id, r.current_read, t.ordinality, t.value
  ), ranked as (
    select r.record_id, r.current_read,
      coalesce(pg_catalog.sum(h.weight) filter (where not h.excluded), 0)::integer as score
    from readable r left join hits h on h.record_id = r.record_id
    group by r.record_id, r.current_read
    having coalesce(pg_catalog.bool_and(case when h.excluded then h.weight = 0 else h.weight > 0 end), true)
  )
  select ranked.record_id, ranked.score, ranked.current_read -> 'record', ranked.current_read -> 'capabilities'
  from ranked
  where p_after_score is null or ranked.score < p_after_score
    or (ranked.score = p_after_score and ranked.record_id > p_after_record_id)
  order by ranked.score desc, ranked.record_id asc
  limit p_limit;
end
$function$;

alter function vortex_record.search_document_page(uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,integer,uuid,integer) owner to vortex_owner;
revoke all on function vortex_record.search_document_page(uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,integer,uuid,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.search_document_page(uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,integer,uuid,integer)
  to vortex_request;
