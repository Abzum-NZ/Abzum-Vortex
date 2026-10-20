create or replace function vortex_record.prepare_system_projection_scan_internal(
  p_plan jsonb,
  p_search jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  filter_condition jsonb := nullif(p_plan #> '{filter,residualCondition}', 'null'::jsonb);
  filter_types jsonb := coalesce(p_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types jsonb := coalesce(p_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values jsonb := coalesce(p_plan #> '{filter,residualInputs}', '{}'::jsonb);
  record_type_item jsonb := p_plan -> 'recordType';
  resolved jsonb := p_plan -> 'resolved';
  v_storage_contract_id uuid := (p_plan #>> '{storage,storageContractId}')::uuid;
  p_module_root_id uuid := (p_plan #>> '{storage,moduleRootId}')::uuid;
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  physical_table_token text := p_plan #>> '{storage,physicalTableToken}';
  user_search text := p_search ->> 'search';
  fields_by_id jsonb;
  filter_ids text[];
  readable_field_ids text[];
  search_field_ids text[];
  projection_field_keys jsonb;
  projection_database_types jsonb;
  projection_search_keys text[];
  projection_predicate jsonb;
  scan_source_sql text;
begin
  -- This plan is local to the query invocation, never caller-writable session state.
  select pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value)
  into fields_by_id
  from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'readableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_search -> 'fieldIds') as item(value);
  -- The prepared filter and search are handed to the bounded reader, which
  -- applies them inside its own indexed keyset scan before the limit. A
  -- field the reader is not guaranteed to see on every row may not decide
  -- which rows a page holds, so it is refused rather than filtered per row.
  if filter_condition is not null then
    if exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select coalesce(pg_catalog.jsonb_object_agg(referenced.id, fields_by_id -> referenced.id ->> 'key'),
      '{}'::jsonb)
    into projection_field_keys
    from pg_catalog.unnest(filter_ids) as referenced(id);
    select coalesce(pg_catalog.jsonb_object_agg(mapping.field_id::text, mapping.database_value_type),
      '{}'::jsonb)
    into projection_database_types
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.state = 'active'
      and mapping.field_id::text = any (filter_ids);
    projection_predicate := pg_catalog.jsonb_build_object('filter', pg_catalog.jsonb_build_object(
      'condition', filter_condition,
      'fieldKeys', projection_field_keys,
      'fieldTypes', filter_types,
      'fieldDatabaseTypes', projection_database_types,
      'inputTypes', parameter_types,
      'inputValues', parameter_values));
  end if;
  if user_search is not null then
    if exists (
      select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
      where searched.id <> all (readable_field_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select coalesce(pg_catalog.array_agg(fields_by_id -> searched.id ->> 'key' order by searched.position),
      array[]::text[])
    into projection_search_keys
    from pg_catalog.unnest(search_field_ids) with ordinality as searched(id, position);
    projection_predicate := coalesce(projection_predicate, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'search', pg_catalog.jsonb_build_object(
        'term', user_search, 'keys', pg_catalog.to_jsonb(projection_search_keys)));
  end if;
  -- The registered view contributes its row type only. The bounded reader
  -- supplies every candidate, including rows later rejected by the query.
  scan_source_sql := pg_catalog.format($source$
    pg_catalog.jsonb_to_recordset($11) as projection(
      organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
    )
    cross join lateral pg_catalog.jsonb_populate_record(
      null::record_data.%I,
      pg_catalog.jsonb_build_object(
        'organisation_id', projection.organization_id,
        'module_root_id', %L::uuid,
        'record_type_id', %L::uuid,
        'storage_contract_id', %L::uuid,
        'record_id', projection.record_id,
        'definition_revision', %L::bigint,
        'lifecycle_state', 'active',
        'concurrency_number', projection.revision
      ) || coalesce((
        select pg_catalog.jsonb_object_agg(
          'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
          case
            when field.value ->> 'fieldId' = %L
              then pg_catalog.to_jsonb(projection.organization_id::text)
            when field.value ->> 'fieldId' = %L
              then pg_catalog.to_jsonb(projection.revision)
            else projection.attribute_values -> (field.value ->> 'key')
          end
        )
        from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
      ), '{}'::jsonb)
    ) as stored$source$,
    physical_table_token, p_module_root_id, record_type_id_value,
    v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
    record_type_item #>> '{systemProjection,organizationFieldId}',
    record_type_item #>> '{systemProjection,revisionFieldId}',
    record_type_item
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'predicate', projection_predicate, 'sourceSql', scan_source_sql);
end
$function$;

alter function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb) is
  'Prepares one bounded system-projection scan from the query invocation''s current private plan: refuses filters or searches over fields not guaranteed readable, builds the typed predicate for the registered reader, and maps its rows into the generated storage row type; performs no row read or predicate evaluation.';
