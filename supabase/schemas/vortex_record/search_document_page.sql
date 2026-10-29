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
  p_limit integer default 40,
  p_state jsonb default null,
  p_max_visits integer default 200
)
returns table (record_id uuid, score integer, record jsonb, capabilities jsonb, state jsonb, frontier_score integer, frontier_id uuid, visits integer)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  candidate record;
  current_read jsonb;
  actual_score integer;
  matches boolean;
  results jsonb := '[]'::jsonb;
  worst_score integer;
  worst_id uuid;
  scan_score integer := (p_state -> 'scan' ->> 'score')::integer;
  scan_id uuid := (p_state -> 'scan' ->> 'id')::uuid;
  held_ids jsonb := coalesce(p_state -> 'held', '[]'::jsonb);
  new_visits integer := 0;
  next_score integer;
  next_id uuid;
  output_rows jsonb := '[]'::jsonb;
  held_rows jsonb := '[]'::jsonb;
  state_value jsonb;
  scan_exhausted boolean;
  item jsonb;
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
    or p_limit is null or p_limit not between 1 and 200
    or p_max_visits is null or p_max_visits not between 1 and 200
    or pg_catalog.jsonb_typeof(held_ids) is distinct from 'array'
    or pg_catalog.jsonb_array_length(held_ids) > 200
    or (scan_score is null) <> (scan_id is null) then
    raise exception using errcode = '22023', message = 'Search page selector is invalid';
  end if;

  -- Each hit is computed once from the index. Its weight is an upper bound:
  -- the protected projection can remove matching fields, never add them.
  for candidate in
    with candidates as materialized (
      select d.record_id, d.source_record_version, hits.terms,
        exists (select 1 from pg_catalog.jsonb_array_elements(held_ids) held(value)
          where (held.value ->> 'id')::uuid = d.record_id) as is_held,
        coalesce((select sum((hit.value ->> 'weight')::integer)
          from pg_catalog.jsonb_array_elements(hits.terms) term(value)
          cross join lateral pg_catalog.jsonb_array_elements(term.value -> 'hits') hit(value)
          where not (term.value ->> 'excluded')::boolean), 0)::integer as upper_score
      from vortex_record.documents d
      cross join lateral (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'excluded', (term.value ->> 'excluded')::boolean,
          'hits', coalesce(matched.hits, '[]'::jsonb)) order by term.ordinality), '[]'::jsonb) as terms
        from pg_catalog.jsonb_array_elements(p_terms) with ordinality term(value, ordinality)
        cross join lateral (
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'fieldId', matched_field.field_id,
            'weight', case field.value ->> 'priority'
              when 'first' then 3 when 'normal' then 2 when 'last' then 1 else 0 end)) as hits
          from (
            select distinct entry.value ->> 'fieldId' as field_id
            from pg_catalog.jsonb_array_elements(d.entries) entry(value)
            cross join lateral (
              select pg_catalog.regexp_split_to_array(pg_catalog.lower(entry.value ->> 'text'),
                '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+') as words,
                array(select pg_catalog.jsonb_array_elements_text(term.value -> 'tokens')) as term_words
            ) tokenized
            where exists (select 1 from pg_catalog.generate_series(1,
              pg_catalog.cardinality(tokenized.words) - pg_catalog.cardinality(tokenized.term_words) + 1) n
              where tokenized.words[n:n + pg_catalog.cardinality(tokenized.term_words) - 1] = tokenized.term_words)
          ) matched_field
          join pg_catalog.jsonb_array_elements(p_fields) field(value)
            on pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(matched_field.field_id)
        ) matched
      ) hits
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
    )
    select c.* from candidates c
    where (c.is_held or (not coalesce((p_state ->> 'done')::boolean, false) and
      (scan_score is null or c.upper_score < scan_score
        or (c.upper_score = scan_score and c.record_id > scan_id))))
      and not exists (select 1 from pg_catalog.jsonb_array_elements(c.terms) term(value)
      where not (term.value ->> 'excluded')::boolean
        and pg_catalog.jsonb_array_length(term.value -> 'hits') = 0)
    order by c.is_held desc, c.upper_score desc, c.record_id asc
  loop
    if not candidate.is_held then
      if (pg_catalog.jsonb_array_length(results) >= p_limit
        and (candidate.upper_score < worst_score
          or (candidate.upper_score = worst_score and candidate.record_id > worst_id)))
        or new_visits >= p_max_visits then
        next_score := candidate.upper_score;
        next_id := candidate.record_id;
        exit;
      end if;
      new_visits := new_visits + 1;
      scan_score := candidate.upper_score;
      scan_id := candidate.record_id;
    end if;

    current_read := vortex_record.read_record(p_record_type_id, candidate.record_id);
    if current_read -> 'record' ->> 'outcome' is distinct from 'allowed'
      or (current_read -> 'record' ->> 'concurrencyNumber')::bigint is distinct from candidate.source_record_version
      or not (current_read -> 'record' -> 'values' ? p_title_field_id::text)
      or current_read -> 'record' -> 'values' -> p_title_field_id::text in ('null'::jsonb, '""'::jsonb)
      or (pg_catalog.jsonb_typeof(current_read -> 'record' -> 'values' -> p_title_field_id::text) = 'string'
        and pg_catalog.btrim(current_read -> 'record' -> 'values' ->> p_title_field_id::text, E' \t\n\r\f' || pg_catalog.chr(11)) = '')
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_filters) f(value)
        where not (current_read -> 'record' -> 'values' ? (f.value ->> 'fieldId'))
          or not vortex_access.evaluate_typed_condition_node_internal(
            f.value -> 'condition',
            pg_catalog.jsonb_build_object(f.value ->> 'fieldId', f.value ->> 'type'),
            pg_catalog.jsonb_build_object(f.value ->> 'fieldId',
              current_read -> 'record' -> 'values' -> (f.value ->> 'fieldId')),
            '{}'::jsonb, '{}'::jsonb, false)
      ) then
      continue;
    end if;

    select coalesce(pg_catalog.sum(term_score.weight) filter (where not term_score.excluded), 0)::integer,
      coalesce(pg_catalog.bool_and(case when term_score.excluded then term_score.weight = 0 else term_score.weight > 0 end), true)
    into actual_score, matches
    from pg_catalog.jsonb_array_elements(candidate.terms) term(value)
    cross join lateral (
      select (term.value ->> 'excluded')::boolean as excluded,
        coalesce(pg_catalog.sum((hit.value ->> 'weight')::integer), 0)::integer as weight
      from pg_catalog.jsonb_array_elements(term.value -> 'hits') hit(value)
      where current_read -> 'record' -> 'values' ? (hit.value ->> 'fieldId')
    ) term_score;
    if not matches or (p_after_score is not null and
      (actual_score > p_after_score or (actual_score = p_after_score and candidate.record_id <= p_after_record_id))) then
      continue;
    end if;

    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', candidate.record_id, 'score', actual_score,
      'record', current_read -> 'record', 'capabilities', current_read -> 'capabilities'));
    select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'score')::integer desc, (item.value ->> 'id')::uuid)
      into results
    from (select value from pg_catalog.jsonb_array_elements(results)
      order by (value ->> 'score')::integer desc, (value ->> 'id')::uuid limit 200) item;
    worst_score := (results -> (least(p_limit, pg_catalog.jsonb_array_length(results)) - 1) ->> 'score')::integer;
    worst_id := (results -> (least(p_limit, pg_catalog.jsonb_array_length(results)) - 1) ->> 'id')::uuid;
  end loop;

  -- Only release rows whose real rank is ahead of the remaining upper bound.
  for item in select value from pg_catalog.jsonb_array_elements(results) loop
    if pg_catalog.jsonb_array_length(output_rows) < p_limit
      and (next_score is null or (item ->> 'score')::integer > next_score
        or ((item ->> 'score')::integer = next_score and (item ->> 'id')::uuid < next_id)) then
      output_rows := output_rows || pg_catalog.jsonb_build_array(item);
    else
      held_rows := held_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', item -> 'id', 'score', item -> 'score'));
    end if;
  end loop;
  scan_exhausted := next_score is null;
  if pg_catalog.jsonb_array_length(held_rows) > 0 and (next_score is null
    or (held_rows -> 0 ->> 'score')::integer > next_score
    or ((held_rows -> 0 ->> 'score')::integer = next_score and (held_rows -> 0 ->> 'id')::uuid < next_id)) then
    next_score := (held_rows -> 0 ->> 'score')::integer;
    next_id := (held_rows -> 0 ->> 'id')::uuid;
  end if;
  state_value := pg_catalog.jsonb_build_object(
    'scan', case when scan_score is null then null else pg_catalog.jsonb_build_object('score', scan_score, 'id', scan_id) end,
    'held', held_rows, 'done', scan_exhausted); 
  if pg_catalog.jsonb_array_length(output_rows) = 0 then
    return query select null::uuid, null::integer, null::jsonb, null::jsonb, state_value, next_score, next_id, new_visits;
  else
    return query select (row.value ->> 'id')::uuid, (row.value ->> 'score')::integer,
      row.value -> 'record', row.value -> 'capabilities', state_value, next_score, next_id, new_visits
    from pg_catalog.jsonb_array_elements(output_rows) with ordinality row(value, ordinality)
    order by row.ordinality;
  end if;
end
$function$;

alter function vortex_record.search_document_page(uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,integer,uuid,integer,jsonb,integer) owner to vortex_owner;
revoke all on function vortex_record.search_document_page(uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,integer,uuid,integer,jsonb,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.search_document_page(uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,integer,uuid,integer,jsonb,integer)
  to vortex_request;
