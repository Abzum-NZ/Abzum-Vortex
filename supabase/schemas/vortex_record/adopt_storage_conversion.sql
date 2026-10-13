CREATE FUNCTION vortex_record.adopt_storage_conversion(p_conversion_contract_id uuid, p_expected_plan_revision bigint, p_application_root_id uuid, p_module_root_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  authority jsonb;
  organisation_id_value uuid;
  scope_application_root_id uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  plan_row vortex_record.storage_conversion_plans%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  target_required boolean;
  lock_sql text;
  check_sql text;
  unfinished_count bigint;
  switched jsonb;
begin
  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_plan_revision is null
    or p_expected_plan_revision not between 1 and 9007199254740991
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Storage adoption command is invalid';
  end if;

  select entry.* into conversion
  from vortex_record.storage_conversion_catalogue as entry
  where entry.conversion_contract_id = p_conversion_contract_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Storage conversion plan is unavailable';
  end if;

  -- The installation is already detached by this transaction, so authority is
  -- proved without requiring an active installation.
  authority := vortex_record.authorize_storage_conversion_internal(
    conversion.source_storage_contract_id, null
  );
  organisation_id_value := (authority ->> 'organizationId')::uuid;
  scope_application_root_id := (authority ->> 'applicationRootId')::uuid;
  if scope_application_root_id is not null
    and scope_application_root_id <> p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Storage adoption Application is outside the request context';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage adoption contract is unavailable';
  end if;
  -- The caller names the converted Module so it can adopt at that Module's
  -- place in the canonical provisioning order; the catalogue decides it.
  if catalogue_row.module_root_id <> p_module_root_id then
    raise exception using errcode = '55000',
      message = 'Storage adoption Module is incompatible';
  end if;

  -- Binding identity first, then the storage lineages: the provisioner's order.
  perform vortex_record.lock_storage_adoption_internal(
    p_conversion_contract_id, organisation_id_value, p_application_root_id
  );

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
  if plan_row.state <> 'converted' then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan is incomplete';
  end if;

  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage adoption target mapping is not allocated';
  end if;
  target_required := coalesce(
    (conversion.target_field_definition ->> 'required')::boolean, false
  );

  -- Hold every in-scope record still while it is judged. A writer of this scope
  -- locks its row before it takes the binding lock this transaction already
  -- holds, so waiting for it here could deadlock: a row still locked by a writer
  -- in flight refuses the adoption as a retryable conflict instead. The next
  -- statement then reads the committed state.
  lock_sql := pg_catalog.format(
    'select 1 from record_data.%I as stored'
      || ' where stored.organisation_id = $1::uuid'
      || ' and stored.application_root_id is not distinct from $2::uuid'
      || ' order by stored.record_id'
      || ' for share of stored nowait',
    catalogue_row.physical_table_token
  );
  begin
    execute lock_sql using organisation_id_value, scope_application_root_id;
  exception
    when lock_not_available then
      raise exception using errcode = '40001',
        message = 'Storage adoption records are being changed';
  end;

  -- The exact candidate predicate of `convert_record_storage_batch`: a record
  -- never converted, or converted under an older concurrency revision, is
  -- unfinished. A required target field must also hold a value.
  check_sql := pg_catalog.format(
    'select pg_catalog.count(*)'
      || ' from record_data.%I as stored'
      || ' left join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and (progress.record_id is null'
      || ' or progress.source_concurrency_number <> stored.concurrency_number'
      || ' or ($4::boolean and stored.%I is null))',
    catalogue_row.physical_table_token, target_mapping.physical_column_token
  );
  execute check_sql into unfinished_count
    using p_conversion_contract_id, organisation_id_value,
      scope_application_root_id, target_required;
  if unfinished_count > 0 then
    raise exception using errcode = '55000',
      message = 'Storage conversion has records changed or missed since conversion';
  end if;

  switched := vortex_record.switch_storage_conversion_mappings_internal(
    p_conversion_contract_id, (authority ->> 'ownsModule')::boolean
  );

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'storageContractId', conversion.source_storage_contract_id,
    'moduleRootId', catalogue_row.module_root_id,
    'sourceFieldId', conversion.source_field_id,
    'targetFieldId', conversion.target_field_id,
    'organisationId', organisation_id_value,
    'applicationRootId', p_application_root_id,
    'sourceReleaseRevision', conversion.source_release_revision,
    'targetReleaseRevision', conversion.target_release_revision,
    'planRevision', plan_row.plan_revision,
    'dependentCount', (switched ->> 'dependentCount')::bigint,
    'changed', (switched ->> 'changed')::boolean
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage adoption evidence is unavailable';
end
$_$;
alter function vortex_record.adopt_storage_conversion(uuid,bigint,uuid,uuid) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.adopt_storage_conversion(p_conversion_contract_id uuid, p_expected_plan_revision bigint, p_application_root_id uuid, p_module_root_id uuid) IS 'Atomic storage adoption for one detached installation: refuses stale or incomplete plans and any remaining installation of a release carrying the source field, then switches the target mapping to active and the source mapping to retired together; never drops a column.';

REVOKE ALL ON FUNCTION vortex_record.adopt_storage_conversion(p_conversion_contract_id uuid, p_expected_plan_revision bigint, p_application_root_id uuid, p_module_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.adopt_storage_conversion(p_conversion_contract_id uuid, p_expected_plan_revision bigint, p_application_root_id uuid, p_module_root_id uuid) TO vortex_request;
