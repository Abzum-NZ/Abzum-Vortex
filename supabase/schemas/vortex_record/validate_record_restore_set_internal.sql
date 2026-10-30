create or replace function vortex_record.validate_record_restore_set_internal(p_subjects jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subjects jsonb := p_subjects;
  subject jsonb;
  field_value jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
begin
  -- Re-evaluate the actual proposed records, including recovered optional
  -- links, before exposing preparation to the runtime rule evaluator.
  for subject in select item.value from pg_catalog.jsonb_array_elements(subjects) as item(value)
  loop
    loaded := (vortex_record.load_record_access_facts_internal(case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (subject ->> 'recordTypeId')::uuid, 'recordId', (subject ->> 'recordId')::uuid))) -> 0);
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (subject ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
    if decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(subject #> '{recordType,fields}') as item(value)
      where (subject #> '{storageChange,values}') ? (subject -> 'columns' -> (item.value ->> 'fieldId') ->> 'token')
    loop
      if not (bounds -> 'changeableFieldIds') ? (field_value ->> 'fieldId') then
        raise exception using errcode = '42501', message = 'Restored relationship is unavailable';
      end if;
    end loop;
  end loop;
end
$function$;

alter function vortex_record.validate_record_restore_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.validate_record_restore_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.validate_record_restore_set_internal(jsonb) is
  'Private restore finalization: checks current authority and changed-field bounds against the complete restored storage and relationship graph.';
