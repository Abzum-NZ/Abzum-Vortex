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
  retained_value jsonb;
  relationship_value jsonb;
  edge_changes jsonb := '[]'::jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
begin
  -- Validate retained fields and prepare links against the complete proposed
  -- closure. Any refusal rolls this preparation back, including its row writes.
  for subject in select item.value from pg_catalog.jsonb_array_elements(subjects) as item(value)
  loop
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(subject #> '{recordType,fields}') as item(value)
    loop
      if not (subject ->> 'deleted')::boolean
        and not (subject #> '{storageChange,values}') ? (
          subject -> 'columns' -> (field_value ->> 'fieldId') ->> 'token'
        ) then continue; end if;
      retained_value := coalesce(subject -> 'values' -> (field_value ->> 'fieldId'), 'null'::jsonb);
      if (field_value ->> 'required')::boolean and retained_value = 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Required retained value is unavailable';
      end if;
      if retained_value = 'null'::jsonb then continue; end if;
      if not vortex_record.canonical_record_value_matches(
        retained_value, field_value ->> 'type',
        subject -> 'columns' -> (field_value ->> 'fieldId') ->> 'databaseValueType'
      ) then
        raise exception using errcode = '23514', message = 'Retained value is invalid';
      end if;
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into strict relationship_value
        from pg_catalog.jsonb_array_elements(subject #> '{recordType,relationships}') as item(value)
        where item.value ->> 'fromFieldId' = field_value ->> 'fieldId';
        begin
          edge_changes := edge_changes || pg_catalog.jsonb_build_array(
            vortex_record.prepare_relationship_value_internal(
              (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
              (relationship_value ->> 'relationshipId')::uuid, retained_value, false
            )
          );
        exception when no_data_found then
          raise exception using errcode = '23514', message = 'Retained relationship is unavailable';
        end;
      end if;
    end loop;
  end loop;
  perform vortex_record.apply_relationship_edges_internal(edge_changes);

  -- Re-evaluate the actual proposed records, including recovered optional
  -- links, before exposing preparation to the runtime rule evaluator.
  for subject in select item.value from pg_catalog.jsonb_array_elements(subjects) as item(value)
  loop
    loaded := vortex_record.load_record_access_facts_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end,
      (subject ->> 'recordId')::uuid, null, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', (subject ->> 'recordId')::uuid, loaded -> 'facts'
    );
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
  'Private restore finalization: validates retained values and recovered targets, applies the prepared edge set once and checks current authority against the complete restored graph.';
