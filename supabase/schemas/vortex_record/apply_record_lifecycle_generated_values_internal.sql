create or replace function vortex_record.apply_record_lifecycle_generated_values_internal(
  p_preparation jsonb,
  p_include_root boolean,
  p_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  expected_mutations jsonb;
  supplied_mutations jsonb;
  mutation_value jsonb;
  prepared_record jsonb;
  reduced_final_values jsonb;
  final_revision bigint;
  revisions jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or p_include_root is null then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values are invalid';
  end if;
  perform vortex_access.validated_human_request_context();

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
        )
        from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') as field(value)
        where field.value ->> 'type' in ('total', 'calculation')
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into expected_mutations
  from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
  where p_include_root or item.value ->> 'recordKey' <> 'root';

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.lower(field_id) order by pg_catalog.lower(field_id) collate "C")
        from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(field_id)
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_mutations
  from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
    and item.value - array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
      = '{}'::jsonb
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';

  if supplied_mutations is distinct from expected_mutations
    or pg_catalog.jsonb_array_length(supplied_mutations)
      <> pg_catalog.jsonb_array_length(p_mutations) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values do not match the locked closure';
  end if;

  for mutation_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_record
    from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
    where item.value ->> 'recordTypeId' = mutation_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = mutation_value ->> 'recordId'
      and (p_include_root or item.value ->> 'recordKey' <> 'root');
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(mutation_value -> 'finalValues') as entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_record -> 'existingValues' -> pg_catalog.lower(entry.key), 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (mutation_value ->> 'recordTypeId')::uuid,
      (mutation_value ->> 'recordId')::uuid,
      (mutation_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
    final_revision := (mutation_value ->> 'expectedConcurrencyNumber')::bigint
      + case when reduced_final_values = '{}'::jsonb then 0 else 1 end;
    revisions := revisions || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', prepared_record ->> 'recordKey',
      'concurrencyNumber', final_revision
    ));
  end loop;
  return revisions;
end
$function$;

revoke all on function vortex_record.apply_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.apply_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb
) is
  'Private lifecycle writer step: applies each locked closure record''s generated values at the revision the shared parent writer reached.';
