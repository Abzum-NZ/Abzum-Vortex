create or replace function vortex_record.module_query_board_member_internal(
  p_bound jsonb,
  p_selector jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  fields_by_id jsonb := p_bound -> 'fieldsById';
  query_item jsonb := p_bound -> 'query';
  board_choice_field_id text := p_selector ->> 'choiceFieldId';
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_choice_column text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
begin
  -- A board reads members of its query's sole grouping key: one filterable choice field of 1..12
  -- closed options that the query selects.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
    or not ((p_bound -> 'selectedFieldIds') ? board_choice_field_id)
    or not (fields_by_id ? board_choice_field_id)
    or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
    or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
  if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
    or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
    if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
      or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
      or not (board_option ? 'value') or not (board_option ? 'label')
      or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
      or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
      or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
      or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
      or (board_option ? 'requiredPermissionId' and (
        pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
        or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
        or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
      ))
      or (board_option ->> 'value') collate "C" = any (board_option_values) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_selector -> 'columns') as requested(value)
    where requested.value ->> 'kind' = 'option'
      and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- A column reads only its own cards. When the reader is guaranteed to see the
  -- choice field on every row the scan examines, the stored choice value is the
  -- readable value, so the column's membership narrows the candidate scan and the
  -- budget is spent on that column's members only. Otherwise the scan stays
  -- unnarrowed and membership is decided from each readable projection, so
  -- a withheld value never decides which rows are examined.
  if (p_bound -> 'readableFieldIds') ? board_choice_field_id then
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = (p_bound ->> 'storageContractId')::uuid
      and mapping.field_id = board_choice_field_id::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    if mapping_row.database_value_type = 'text' then
      board_choice_column := mapping_row.physical_column_token;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'kind', 'choice',
    'choiceFieldId', board_choice_field_id,
    'optionValues', pg_catalog.to_jsonb(board_option_values),
    'columns', p_selector -> 'columns',
    'choiceColumn', board_choice_column
  );
end
$function$;

alter function vortex_record.module_query_board_member_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_member_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_member_internal(jsonb,jsonb) is
  'Adapter-only board membership of a bound Module query page read: requires the query''s sole grouping key to be the selected, filterable choice field the board names with 1 to 12 closed options, every requested option column to be one of them, and returns the closed choice membership value with the stored choice column only when the reader is guaranteed to see the choice field on every scanned row.';
