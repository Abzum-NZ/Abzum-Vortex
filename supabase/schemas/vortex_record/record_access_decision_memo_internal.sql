create or replace function vortex_record.record_access_decision_memo_internal(
  p_entries jsonb,
  p_memo jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  decision_chunk record;
  decisions jsonb;
  decided jsonb := '[]'::jsonb;
  bounds_memo jsonb;
begin
  -- Each entry names its owner (the position of the record intent it answers for) and one exact
  -- access input. The whole set is decided together, never one call per record: each distinct
  -- input is decided once, in calls of at most 200. A decision is remembered under the digest of
  -- its exact input, so a memo never answers for a different declaration, record or facts, and
  -- the field bounds of every distinct allowed decision are taken once, not once per record.
  -- The decisions of an earlier memo are kept.
  if p_entries is null or pg_catalog.jsonb_array_length(p_entries) = 0 then
    return coalesce(p_memo, '{}'::jsonb);
  end if;
  for decision_chunk in
    select numbered.chunk, pg_catalog.jsonb_agg(numbered.input order by numbered.position) as inputs,
      pg_catalog.array_agg(numbered.digest order by numbered.position) as digests
    from (
      select distinct_input.digest, distinct_input.input,
        pg_catalog.row_number() over (order by distinct_input.digest) as position,
        (pg_catalog.row_number() over (order by distinct_input.digest) - 1) / 200 as chunk
      from (
        select distinct on (digest) entry.digest, entry.input
        from (
          select item.value -> 'input' as input,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((item.value -> 'input')::text, 'UTF8')), 'hex') as digest
          from pg_catalog.jsonb_array_elements(p_entries) as item(value)
        ) as entry
        order by entry.digest
      ) as distinct_input
    ) as numbered
    group by numbered.chunk
    order by numbered.chunk
  loop
    decisions := vortex_access.evaluate_organization_record_access_internal(decision_chunk.inputs);
    decided := decided || (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'digest', decision_chunk.digests[decision.ordinality], 'decision', decision.value)
        order by decision.ordinality)
      from pg_catalog.jsonb_array_elements(decisions) with ordinality as decision(value, ordinality));
  end loop;

  select coalesce(pg_catalog.jsonb_object_agg(distinct_decision.key, pg_catalog.jsonb_build_object(
      'resolved', vortex_access.resolve_record_field_bounds_internal(distinct_decision.decision),
      'decided', vortex_record.decide_record_field_bounds_internal(distinct_decision.decision))), '{}'::jsonb)
  into bounds_memo
  from (
    select distinct on (vortex_record.record_field_bounds_key_internal(entry.value -> 'decision'))
      vortex_record.record_field_bounds_key_internal(entry.value -> 'decision') as key,
      entry.value -> 'decision' as decision
    from pg_catalog.jsonb_array_elements(decided) as entry(value)
    where entry.value #>> '{decision,outcome}' = 'allowed'
  ) as distinct_decision;
  bounds_memo := coalesce((select first_owner.value -> 'bounds' from pg_catalog.jsonb_each(coalesce(p_memo, '{}'::jsonb)) as first_owner limit 1), '{}'::jsonb)
    || bounds_memo;

  return (
    select coalesce(pg_catalog.jsonb_object_agg(owned.owner, pg_catalog.jsonb_build_object(
      'decisions', owned.entries, 'bounds', bounds_memo)), '{}'::jsonb)
    from (
      select answered.owner, pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('digest', answered.digest, 'decision', answered.decision)
        order by answered.stage, answered.position) as entries
      from (
        select previous.key as owner, 0 as stage, remembered.ordinality as position,
          remembered.value ->> 'digest' as digest, remembered.value -> 'decision' as decision
        from pg_catalog.jsonb_each(coalesce(p_memo, '{}'::jsonb)) as previous(key, value)
        cross join lateral pg_catalog.jsonb_array_elements(previous.value -> 'decisions')
          with ordinality as remembered(value, ordinality)
        union all
        select item.owner, 1, item.position, item.digest, known.value -> 'decision'
        from (
          select entry.value ->> 'owner' as owner, entry.ordinality as position,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((entry.value -> 'input')::text, 'UTF8')), 'hex') as digest
          from pg_catalog.jsonb_array_elements(p_entries) with ordinality as entry(value, ordinality)
        ) as item
        join pg_catalog.jsonb_array_elements(decided) as known(value)
          on known.value ->> 'digest' = item.digest
      ) as answered
      group by answered.owner
    ) as owned
  );
end
$function$;
alter function vortex_record.record_access_decision_memo_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_access_decision_memo_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_access_decision_memo_internal(jsonb,jsonb) is
  'Private set-wide access decisions: decides every distinct entry input once, in calls of at most 200, and returns per owner the decisions (by digest of their input) and the field bounds of each distinct allowed decision, for decide_record_access_internal and remembered_record_field_bounds_internal to reuse; an earlier memo''s decisions are kept.';
