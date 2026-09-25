create or replace function vortex_record.read_time_deadline_expression_internal(
  p_storage_contract_id uuid,
  p_expression jsonb,
  p_clock jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  due_mapping vortex_record.field_storage_mappings%rowtype;
  status_mapping vortex_record.field_storage_mappings%rowtype;
  terminal_values jsonb;
  terminal_sql text := 'false';
  comparison_sql text;
begin
  if p_storage_contract_id is null or p_clock is null
    or pg_catalog.jsonb_typeof(p_expression) is distinct from 'object'
    or p_expression ->> 'kind' is distinct from 'deadline_passed'
    or pg_catalog.jsonb_typeof(p_expression -> 'dueFieldId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_clock -> 'instant') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_clock -> 'organizationLocalDate') is distinct from 'string' then
    return null;
  end if;
  select mapping.* into due_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = (pg_catalog.lower(p_expression ->> 'dueFieldId'))::uuid;
  if not found or due_mapping.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;
  if due_mapping.database_value_type not in ('date', 'timestamp_with_time_zone') then
    return null;
  end if;
  if pg_catalog.jsonb_typeof(p_expression -> 'statusFieldId') = 'string' then
    terminal_values := coalesce(p_expression -> 'terminalStatusValues', '[]'::jsonb);
    if pg_catalog.jsonb_typeof(terminal_values) <> 'array' then
      return null;
    end if;
    select mapping.* into status_mapping
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.field_id = (pg_catalog.lower(p_expression ->> 'statusFieldId'))::uuid;
    if not found or status_mapping.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    if status_mapping.database_value_type not in ('text', 'integer', 'boolean', 'uuid') then
      return null;
    end if;
    if pg_catalog.jsonb_array_length(terminal_values) > 0 then
      terminal_sql := pg_catalog.format(
        '(stored.%I is not null and pg_catalog.to_jsonb(stored.%I) in (%s))',
        status_mapping.physical_column_token, status_mapping.physical_column_token,
        (select pg_catalog.string_agg(pg_catalog.format('%L::jsonb', terminal.value::text), ', ')
         from pg_catalog.jsonb_array_elements(terminal_values) as terminal(value))
      );
    end if;
  end if;
  comparison_sql := case due_mapping.database_value_type
    when 'date' then pg_catalog.format(
      '%L::date > stored.%I', p_clock ->> 'organizationLocalDate', due_mapping.physical_column_token)
    else pg_catalog.format(
      '%L::timestamp with time zone >= stored.%I', p_clock ->> 'instant', due_mapping.physical_column_token)
  end;
  return pg_catalog.format(
    '(case when %s then false when stored.%I is null then null else %s end)',
    terminal_sql, due_mapping.physical_column_token, comparison_sql
  );
end
$function$;

revoke all on function vortex_record.read_time_deadline_expression_internal(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.read_time_deadline_expression_internal(uuid, jsonb, jsonb) is
  'Compiles one deadline-passed calculation to a boolean SQL expression over the stored due and status columns of the record alias, using the supplied statement clock, or returns null when the calculation cannot be compiled; owner-only.';
