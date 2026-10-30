create or replace function vortex_record.proposed_update_facts_internal(
  p_loaded jsonb,
  p_record_id uuid,
  p_final_values jsonb,
  p_relationship_changes jsonb,
  p_records jsonb,
  p_edges jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  proposed_field_values jsonb := (p_loaded -> 'fieldValues') || p_final_values;
  proposed_records jsonb;
  proposed_edges jsonb;
begin
  -- Target closures may reach the source through a currently permitted
  -- relationship route. Assemble all trusted closures first, then make the
  -- source authoritative exactly once so an old source copy cannot compete
  -- with the proposed values. Other repeated closure records are collapsed by
  -- their permanent Record identity.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case when unique_record.record_id = p_record_id
        then unique_record.value || pg_catalog.jsonb_build_object(
          'fieldValues', proposed_field_values
        )
        else unique_record.value end
      order by unique_record.record_id
    )
    from (
      select distinct on (
        (record.value -> 'recordScope' ->> 'recordId')::uuid
      )
        (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
        record.value
      from pg_catalog.jsonb_array_elements(p_records) as record(value)
      order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
        record.value::text collate "C"
    ) as unique_record
  ), '[]'::jsonb);

  -- Apply every changed fixed relationship after closure assembly. This one
  -- replacement pass removes old source edges even when a target closure
  -- contained them, then adds only the submitted non-null replacements.
  proposed_edges := coalesce((
    with retained_edges as (
      select edge.value
      from pg_catalog.jsonb_array_elements(p_edges) as edge(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_relationship_changes) as changed(value)
        where (changed.value ->> 'relationshipId')::uuid =
            (edge.value ->> 'relationshipId')::uuid
          and (edge.value ->> 'fromRecordId')::uuid = p_record_id
      )
    ), replacement_edges as (
      select pg_catalog.jsonb_build_object(
        'relationshipId', changed.value -> 'relationshipId',
        'fromRecordId', p_record_id,
        'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
      ) as value
      from pg_catalog.jsonb_array_elements(p_relationship_changes) as changed(value)
      where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
    ), unique_edges as (
      select distinct candidate.value
      from (
        select retained.value from retained_edges as retained
        union all
        select replacement.value from replacement_edges as replacement
      ) as candidate(value)
    )
    select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
    from unique_edges as unique_edge
  ), '[]'::jsonb);

  return (p_loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'records', proposed_records,
    'edges', proposed_edges
  );
end
$function$;
alter function vortex_record.proposed_update_facts_internal(jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.proposed_update_facts_internal(jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.proposed_update_facts_internal(jsonb,uuid,jsonb,jsonb,jsonb,jsonb) is
  'Private pure step of record update preparation: the complete proposed source facts (closure records collapsed by identity, the source carrying its proposed values, changed fixed relationships replaced) that the proposed-state access decision is made on; one definition for the per-record and the set-wide decision.';
