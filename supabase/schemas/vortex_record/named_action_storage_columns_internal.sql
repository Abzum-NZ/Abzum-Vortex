create or replace function vortex_record.named_action_storage_columns_internal(
  p_storage_contract_id uuid,
  p_fields jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  columns_value jsonb;
  storage_disagrees boolean;
  value_expression text;
begin
  -- The column map of one record type's storage: every declared field's active
  -- physical column, keyed by its lower-case field identity.
  select coalesce(pg_catalog.bool_or(
      mapping.storage_contract_id is null or mapping.state <> 'active'
    ), false),
    coalesce(pg_catalog.jsonb_object_agg(
      pg_catalog.lower(field_item.value ->> 'fieldId'),
      pg_catalog.jsonb_build_object(
        'token', mapping.physical_column_token,
        'databaseValueType', mapping.database_value_type,
        'type', field_item.value ->> 'type'
      )
      order by field_item.ordinality
    ) filter (where mapping.storage_contract_id is not null), '{}'::jsonb)
  into storage_disagrees, columns_value
  from pg_catalog.jsonb_array_elements(p_fields) with ordinality as field_item(value, ordinality)
  left join vortex_record.field_storage_mappings as mapping
    on mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = (field_item.value ->> 'fieldId')::uuid;
  if storage_disagrees then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;

  -- The one value expression that reads this record type's row.
  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s',
          ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then
              pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
                ordered_fields.value ->> 'token'
              )
            when 'date' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                ordered_fields.value ->> 'token'
              )
            else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
          end
        ),
        ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select column_entry.key, column_entry.value,
        pg_catalog.row_number() over (
          order by column_entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  return pg_catalog.jsonb_build_object(
    'columns', columns_value,
    'valueExpression', value_expression
  );
end
$function$;

alter function vortex_record.named_action_storage_columns_internal(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) to vortex_record_adapter;

comment on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) is
  'Private column map and row value expression of one record type storage, built only for the record types a named-action facts load reads.';

-- Selected record projections can also run inside owner-owned query adapters.
grant execute on function vortex_record.named_action_storage_columns_internal(uuid,jsonb) to vortex_owner;
