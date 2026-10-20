create or replace function vortex_record.pivot_query_internal(
  p_query jsonb,
  p_record_type jsonb,
  p_pivot jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  row_field_id text;
  column_field_id text;
  measure jsonb := p_pivot -> 'measure';
  measure_operation text;
  measure_field_id text;
  measure_field jsonb;
  measure_type text;
  measure_alias constant text := 'pivot_measure';
  aggregate jsonb;
begin
  -- A pivot crosses two selected, filterable choice or date dimensions with one measure. Both
  -- dimensions are checked by the grouping validator, so they follow exactly its rules.
  if pg_catalog.jsonb_typeof(p_pivot) is distinct from 'object'
    or p_pivot - array['rowFieldId', 'rowDateBucket', 'columnFieldId', 'columnDateBucket', 'measure', 'rowLimit']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_pivot -> 'rowFieldId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_pivot -> 'columnFieldId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_pivot -> 'rowLimit') is distinct from 'number'
    or pg_catalog.jsonb_typeof(measure) is distinct from 'object' then
    return null;
  end if;
  row_field_id := pg_catalog.lower(p_pivot ->> 'rowFieldId');
  column_field_id := pg_catalog.lower(p_pivot ->> 'columnFieldId');
  if row_field_id = column_field_id
    or vortex_record.grouping_query_internal(
      p_query, p_record_type,
      pg_catalog.jsonb_build_object('fieldId', row_field_id, 'limit', p_pivot -> 'rowLimit')
        || case when p_pivot ? 'rowDateBucket'
          then pg_catalog.jsonb_build_object('dateBucket', p_pivot -> 'rowDateBucket')
          else '{}'::jsonb end
    ) is null
    or vortex_record.grouping_query_internal(
      p_query, p_record_type,
      pg_catalog.jsonb_build_object('fieldId', column_field_id, 'limit', 1)
        || case when p_pivot ? 'columnDateBucket'
          then pg_catalog.jsonb_build_object('dateBucket', p_pivot -> 'columnDateBucket')
          else '{}'::jsonb end
    ) is null then
    return null;
  end if;

  if measure - array['operation', 'fieldId']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(measure -> 'operation') is distinct from 'string' then
    return null;
  end if;
  measure_operation := measure ->> 'operation';
  if measure_operation not in ('count', 'sum', 'average', 'minimum', 'maximum') then
    return null;
  end if;
  if measure_operation = 'count' then
    if measure ? 'fieldId' then return null; end if;
    aggregate := pg_catalog.jsonb_build_object('operation', 'count', 'alias', measure_alias);
  else
    if pg_catalog.jsonb_typeof(measure -> 'fieldId') is distinct from 'string' then return null; end if;
    measure_field_id := pg_catalog.lower(measure ->> 'fieldId');
    if measure_field_id !~ uuid_pattern or not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(p_query -> 'selectedFieldIds') as selected(id)
      where pg_catalog.lower(selected.id) = measure_field_id
    ) then
      return null;
    end if;
    select item.value into measure_field
    from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = measure_field_id;
    if measure_field is null then return null; end if;
    measure_type := case when measure_field ->> 'type' = 'calculation'
      then measure_field #>> '{settings,resultType}' else measure_field ->> 'type' end;
    -- A stored numeric calculation passes as its result type; the summary re-checks its kind.
    if measure_type not in ('whole_number', 'decimal_number', 'money') then return null; end if;
    aggregate := pg_catalog.jsonb_build_object(
      'operation', measure_operation, 'fieldId', measure_field_id, 'alias', measure_alias
    );
  end if;
  return p_query || pg_catalog.jsonb_build_object(
    'groupByFieldIds', pg_catalog.jsonb_build_array(row_field_id, column_field_id),
    'aggregates', pg_catalog.jsonb_build_array(aggregate)
  );
end
$function$;

alter function vortex_record.pivot_query_internal(jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.pivot_query_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.pivot_query_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.pivot_query_internal(jsonb,jsonb,jsonb) is
  'Owner-only validation of one pivot: two distinct selected, filterable choice or date dimensions checked by the grouping validator, and one count, or a sum, average, minimum or maximum over a selected numeric or currency field. Returns the query with its grouping and aggregates replaced by the pivot, or null. The summary checks live field policy before disclosure.';
