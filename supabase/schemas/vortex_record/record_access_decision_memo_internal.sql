create or replace function vortex_record.record_access_decision_memo_internal(
  p_entries jsonb
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
  remembered jsonb := '[]'::jsonb;
  bounds_memo jsonb;
begin
  -- Each entry names its owner (the position of the record intent it answers for) and one exact
  -- access input. The whole set is decided together, never one call per record: each call takes
  -- at most 200 inputs. A decision is remembered under the digest of its exact input, so a memo
  -- never answers for a different declaration, record or facts, and the field bounds of every
  -- distinct allowed decision are taken once, not once per record.
  if p_entries is null or pg_catalog.jsonb_array_length(p_entries) = 0 then
    return '{}'::jsonb;
  end if;
  for decision_chunk in
    select numbered.chunk, pg_catalog.jsonb_agg(numbered.input order by numbered.position) as inputs,
      pg_catalog.array_agg(numbered.owner order by numbered.position) as owners,
      pg_catalog.array_agg(numbered.digest order by numbered.position) as digests
    from (
      select entry.value ->> 'owner' as owner, entry.value -> 'input' as input,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((entry.value -> 'input')::text, 'UTF8')), 'hex') as digest,
        entry.ordinality as position, (entry.ordinality - 1) / 200 as chunk
      from pg_catalog.jsonb_array_elements(p_entries) with ordinality as entry(value, ordinality)
    ) as numbered
    group by numbered.chunk
    order by numbered.chunk
  loop
    decisions := vortex_access.evaluate_organization_record_access_internal(decision_chunk.inputs);
    remembered := remembered || (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'owner', decision_chunk.owners[decision.ordinality],
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
    from pg_catalog.jsonb_array_elements(remembered) as entry(value)
    where entry.value #>> '{decision,outcome}' = 'allowed'
  ) as distinct_decision;
  return (
    select coalesce(pg_catalog.jsonb_object_agg(owned.owner, pg_catalog.jsonb_build_object(
      'decisions', owned.entries, 'bounds', bounds_memo)), '{}'::jsonb)
    from (
      select entry.value ->> 'owner' as owner, pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('digest', entry.value -> 'digest', 'decision', entry.value -> 'decision')
        order by entry.ordinality) as entries
      from pg_catalog.jsonb_array_elements(remembered) with ordinality as entry(value, ordinality)
      group by entry.value ->> 'owner'
    ) as owned
  );
end
$function$;
alter function vortex_record.record_access_decision_memo_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_access_decision_memo_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_access_decision_memo_internal(jsonb) is
  'Private set-wide access decisions: decides every entry''s exact input in calls of at most 200, and returns per owner the decisions (by digest of their input) and the field bounds of each distinct allowed decision, for decide_record_access_internal and remembered_record_field_bounds_internal to reuse.';
