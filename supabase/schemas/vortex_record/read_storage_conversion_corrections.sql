CREATE FUNCTION vortex_record.read_storage_conversion_corrections(p_conversion_contract_id uuid, p_limit integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  authority jsonb;
  organisation_id_value uuid;
  scope_application_root_id uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  count_sql text;
  list_sql text;
  correction_row record;
  changed_count bigint := 0;
  corrections jsonb := '[]'::jsonb;
begin
  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023',
      message = 'Storage conversion correction command is invalid';
  end if;

  select entry.* into conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Storage conversion plan is unavailable';
  end if;

  authority := vortex_record.authorize_storage_conversion_internal(
    conversion.source_storage_contract_id, conversion.source_release_revision
  );
  organisation_id_value := (authority ->> 'organizationId')::uuid;
  scope_application_root_id := (authority ->> 'applicationRootId')::uuid;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  count_sql := pg_catalog.format(
    'select pg_catalog.count(*)'
      || ' from record_data.%I as stored'
      || ' join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and progress.source_concurrency_number <> stored.concurrency_number',
    catalogue_row.physical_table_token
  );
  execute count_sql into changed_count
    using p_conversion_contract_id, organisation_id_value, scope_application_root_id;

  list_sql := pg_catalog.format(
    'select stored.record_id, progress.source_concurrency_number,'
      || ' stored.concurrency_number'
      || ' from record_data.%I as stored'
      || ' join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and progress.source_concurrency_number <> stored.concurrency_number'
      || ' order by stored.record_id'
      || ' limit $4::integer',
    catalogue_row.physical_table_token
  );
  for correction_row in execute list_sql
    using p_conversion_contract_id, organisation_id_value,
      scope_application_root_id, p_limit
  loop
    corrections := corrections || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', correction_row.record_id,
        'sourceConcurrencyNumber', correction_row.source_concurrency_number,
        'currentConcurrencyNumber', correction_row.concurrency_number
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'organisationId', organisation_id_value,
    'applicationRootId', scope_application_root_id,
    'conversionSemantic', conversion.conversion_semantic,
    'changedCount', changed_count,
    'corrections', corrections
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion correction evidence is unavailable';
end
$_$;

COMMENT ON FUNCTION vortex_record.read_storage_conversion_corrections(p_conversion_contract_id uuid, p_limit integer) IS 'Authorised correction facts for the caller''s scope: converted record ids whose live concurrency revision differs from the recorded source revision, with no field values or physical names.';

REVOKE ALL ON FUNCTION vortex_record.read_storage_conversion_corrections(p_conversion_contract_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_storage_conversion_corrections(p_conversion_contract_id uuid, p_limit integer) TO vortex_request;
