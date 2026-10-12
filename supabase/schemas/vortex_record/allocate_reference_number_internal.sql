CREATE FUNCTION vortex_record.allocate_reference_number_internal(p_organization_id uuid, p_storage_contract_id uuid, p_field_id uuid, p_application_root_id uuid, p_settings jsonb) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  start_number numeric(78,0);
  allocated numeric(78,0);
  digit_width integer;
  prefix_value text;
  suffix_value text;
begin
  if pg_catalog.jsonb_typeof(p_settings) <> 'object'
    or pg_catalog.jsonb_typeof(p_settings -> 'digits') <> 'number'
    or (p_settings ->> 'digits')::integer not between 1 and 20
    or (p_settings ? 'startingNumber' and (
      pg_catalog.jsonb_typeof(p_settings -> 'startingNumber') <> 'number'
      or (p_settings ->> 'startingNumber')::numeric < 1
      or pg_catalog.trunc((p_settings ->> 'startingNumber')::numeric)
        <> (p_settings ->> 'startingNumber')::numeric
    )) then
    raise exception using errcode = '22023', message = 'Reference-number settings are invalid';
  end if;
  digit_width := (p_settings ->> 'digits')::integer;
  start_number := coalesce((p_settings ->> 'startingNumber')::numeric, 1);
  prefix_value := coalesce(p_settings ->> 'prefix', '');
  suffix_value := coalesce(p_settings ->> 'suffix', '');

  insert into vortex_record.record_reference_counters (
    organization_id, storage_contract_id, field_id, application_root_id, next_number
  ) values (
    p_organization_id, p_storage_contract_id, p_field_id, p_application_root_id,
    start_number + 1
  )
  on conflict (organization_id, storage_contract_id, field_id, application_root_id)
    do update set next_number = vortex_record.record_reference_counters.next_number + 1,
      changed_at = pg_catalog.statement_timestamp()
  returning next_number - 1 into allocated;

  return prefix_value
    || pg_catalog.lpad(
      allocated::text,
      case when pg_catalog.length(allocated::text) > digit_width
        then pg_catalog.length(allocated::text) else digit_width end,
      '0'
    )
    || suffix_value;
end
$$;

REVOKE ALL ON FUNCTION vortex_record.allocate_reference_number_internal(p_organization_id uuid, p_storage_contract_id uuid, p_field_id uuid, p_application_root_id uuid, p_settings jsonb) FROM PUBLIC;
