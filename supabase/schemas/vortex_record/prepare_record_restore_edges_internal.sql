create or replace function vortex_record.prepare_record_restore_edges_internal(p_subjects jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subject jsonb;
  field_value jsonb;
  retained_value jsonb;
  relationship_value jsonb;
  edge_changes jsonb := '[]'::jsonb;
begin
  -- Storage has restored the complete proposed closure. Validate retained fields
  -- and collect its links before the command applies all relationship changes.
  for subject in select item.value from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
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
  return edge_changes;
end
$function$;
alter function vortex_record.prepare_record_restore_edges_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_edges_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_edges_internal(jsonb) is
  'Private restore edge preparation over the restored storage set: validates retained fields and targets, returning links for the command-wide edge write.';
