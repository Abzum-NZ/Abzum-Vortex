create or replace function vortex_record.proposed_change_facts_internal(
  p_loaded jsonb,
  p_record_id uuid,
  p_final_values jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  proposed_values jsonb := p_loaded -> 'fieldValues';
  entry_key text;
  entry_value jsonb;
  proposed_records jsonb;
begin
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(p_loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  return pg_catalog.jsonb_build_object(
    'values', proposed_values,
    'facts', (p_loaded -> 'facts') || pg_catalog.jsonb_build_object('records', proposed_records)
  );
end
$function$;
alter function vortex_record.proposed_change_facts_internal(jsonb,uuid,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.proposed_change_facts_internal(jsonb,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.proposed_change_facts_internal(jsonb,uuid,jsonb) is
  'Private pure step of record change preparation: the record''s proposed field values and the loaded facts carrying them, which the proposed-state access decision is made on; one definition for the per-record and the set-wide decision.';
