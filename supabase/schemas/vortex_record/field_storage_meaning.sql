create or replace function vortex_record.field_storage_meaning(p_field jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  -- What existing stored values depend on: the field's identity, type and the settings that
  -- decide how a value is stored. Validation settings (lengths, bounds, allowed kinds), choice
  -- option labels and order, where the offered options come from (optionsSource), and the
  -- required, unique, filterable and sortable flags are not storage: an upgrade adjusts their
  -- constraints and indexes instead.
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field -> 'fieldId',
    'type', p_field -> 'type',
    'settings', case p_field ->> 'type'
      when 'link' then (p_field -> 'settings') - 'reverseName' - 'optionsSource'
      when 'link_to_one_of_several' then (p_field -> 'settings') - 'optionsSource'
      when 'decimal_number' then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'digitsBeforeDecimal', p_field #> '{settings,digitsBeforeDecimal}',
        'decimalPlaces', p_field #> '{settings,decimalPlaces}'))
      when 'money' then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'currencyMode', p_field #> '{settings,currencyMode}',
        'currency', p_field #> '{settings,currency}'))
      when 'table' then (p_field -> 'settings') || pg_catalog.jsonb_build_object('columns', (
        select coalesce(pg_catalog.jsonb_agg(
          case when pg_catalog.jsonb_typeof(column_item.value -> 'settings') = 'object'
            then pg_catalog.jsonb_set(
              column_item.value, '{settings}', (column_item.value -> 'settings') - 'optionsSource')
            else column_item.value end
          order by column_item.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(
          coalesce(p_field #> '{settings,columns}', '[]'::jsonb)
        ) with ordinality as column_item(value, ordinality)))
      when 'calculation' then p_field -> 'settings'
      when 'total' then p_field -> 'settings'
      when 'reference_number' then p_field -> 'settings'
      else '{}'::jsonb end
  )
$$;
alter function vortex_record.field_storage_meaning(jsonb) owner to vortex_owner;

revoke all on function vortex_record.field_storage_meaning(jsonb) from public;
