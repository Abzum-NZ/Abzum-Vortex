CREATE FUNCTION vortex_record.convert_record_storage_batch(p_conversion_contract_id uuid, p_batch_size integer, p_expected_plan_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  authority jsonb;
  organisation_id_value uuid;
  scope_application_root_id uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  plan_row vortex_record.storage_conversion_plans%rowtype;
  target_column_token text;
  assignment text;
  select_sql text;
  update_sql text;
  record_row record;
  candidate_count integer := 0;
  processed integer := 0;
  first_conversions integer := 0;
  last_record_id_value uuid;
  next_revision bigint;
  next_state text;
  has_more boolean := false;
begin
  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_batch_size is null
    or p_batch_size not between 1 and 10000
    or p_expected_plan_revision is null
    or p_expected_plan_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Storage conversion batch command is invalid';
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

  -- A shared hold on the storage-lineage lock: batches in different scopes run
  -- together, but no provision, staging or switch can change the mappings or
  -- columns underneath a running batch.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'vortex_record.storage:' || conversion.source_storage_contract_id::text, 0
    )
  );

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  select plan.* into plan_row
  from vortex_record.storage_conversion_plans as plan
  where plan.conversion_contract_id = p_conversion_contract_id
    and plan.organisation_id = organisation_id_value
    and plan.application_root_id is not distinct from scope_application_root_id
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan is not allocated';
  end if;
  if plan_row.plan_revision <> p_expected_plan_revision then
    raise exception using errcode = '40001',
      message = 'Storage conversion plan changed';
  end if;
  if plan_row.plan_revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Storage conversion plan revision is exhausted';
  end if;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id;
  if not found or source_mapping.state <> 'active'
    or source_mapping.database_value_type <> conversion.source_database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion source mapping is incompatible';
  end if;

  target_column_token := 'f_' || pg_catalog.replace(
    pg_catalog.lower(conversion.target_field_id::text), '-', ''
  );
  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;
  if not found or target_mapping.state <> 'planned'
    or target_mapping.physical_column_token <> target_column_token
    or target_mapping.database_value_type <> conversion.target_database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion target mapping is not allocated';
  end if;

  assignment := vortex_record.conversion_value_assignment(
    conversion.conversion_semantic, source_mapping.physical_column_token,
    target_column_token
  );
  if assignment is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion semantic is unsupported';
  end if;

  -- Every record in scope that is not yet converted, or that was converted
  -- under an older concurrency revision, is a candidate, including records
  -- whose source value is empty (their target is emptied too). Selecting by the
  -- recorded progress rather than a moving cursor means a record written after
  -- a previous batch, including one whose id orders before the last converted
  -- one, is never stranded unconverted. Candidate rows are locked, so a writer
  -- waits for this batch and then moves the revision this batch records.
  select_sql := pg_catalog.format(
    'select stored.record_id, stored.concurrency_number'
      || ' from record_data.%I as stored'
      || ' left join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and (progress.record_id is null'
      || ' or progress.source_concurrency_number <> stored.concurrency_number)'
      || ' order by stored.record_id'
      || ' limit $4::integer'
      || ' for update of stored',
    catalogue_row.physical_table_token
  );
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s'
      || ' where stored.organisation_id = $1::uuid'
      || ' and stored.application_root_id is not distinct from $2::uuid'
      || ' and stored.record_id = $3::uuid',
    catalogue_row.physical_table_token, assignment
  );

  for record_row in execute select_sql
    using p_conversion_contract_id, organisation_id_value,
      scope_application_root_id, p_batch_size + 1
  loop
    candidate_count := candidate_count + 1;
    if candidate_count > p_batch_size then
      has_more := true;
      exit;
    end if;

    execute update_sql
      using organisation_id_value, scope_application_root_id, record_row.record_id;

    update vortex_record.storage_conversion_progress as progress
    set source_concurrency_number = record_row.concurrency_number,
        converted_at = pg_catalog.statement_timestamp()
    where progress.conversion_contract_id = p_conversion_contract_id
      and progress.organisation_id = organisation_id_value
      and progress.application_root_id is not distinct from scope_application_root_id
      and progress.record_id = record_row.record_id;
    if not found then
      insert into vortex_record.storage_conversion_progress (
        conversion_contract_id, organisation_id, application_root_id, record_id,
        source_concurrency_number
      ) values (
        p_conversion_contract_id, organisation_id_value, scope_application_root_id,
        record_row.record_id, record_row.concurrency_number
      );
      first_conversions := first_conversions + 1;
    end if;

    processed := processed + 1;
    last_record_id_value := record_row.record_id;
  end loop;

  next_state := case when has_more then 'converting' else 'converted' end;

  -- An already-complete plan with nothing new to convert is returned unchanged
  -- rather than burning a revision.
  if processed = 0 and plan_row.state = 'converted' then
    next_revision := plan_row.plan_revision;
  else
    next_revision := plan_row.plan_revision + 1;
    update vortex_record.storage_conversion_plans as plan
    set state = next_state,
        converted_count = plan.converted_count + first_conversions,
        last_record_id = coalesce(last_record_id_value, plan.last_record_id),
        plan_revision = next_revision,
        changed_at = pg_catalog.statement_timestamp()
    where plan.conversion_contract_id = p_conversion_contract_id
      and plan.organisation_id = organisation_id_value
      and plan.application_root_id is not distinct from scope_application_root_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'organisationId', organisation_id_value,
    'applicationRootId', scope_application_root_id,
    'state', next_state,
    'planRevision', next_revision,
    'convertedCount', plan_row.converted_count + first_conversions,
    'batchConverted', processed,
    'hasMore', has_more,
    'changed', next_revision <> plan_row.plan_revision
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion batch evidence is unavailable';
end
$_$;
alter function vortex_record.convert_record_storage_batch(uuid,integer,bigint) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.convert_record_storage_batch(p_conversion_contract_id uuid, p_batch_size integer, p_expected_plan_revision bigint) IS 'Converts a bounded batch of the caller''s records into the planned target column under the adapter row-level security scope, recording each source concurrency revision; never bumps concurrency, writes the source column or activates the target.';

REVOKE ALL ON FUNCTION vortex_record.convert_record_storage_batch(p_conversion_contract_id uuid, p_batch_size integer, p_expected_plan_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.convert_record_storage_batch(p_conversion_contract_id uuid, p_batch_size integer, p_expected_plan_revision bigint) TO vortex_request;
