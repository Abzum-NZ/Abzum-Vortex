CREATE FUNCTION vortex_record.allocate_storage_conversion_plan(p_conversion_contract_id uuid, p_expected_plan_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  authority jsonb;
  organisation_id_value uuid;
  scope_application_root_id uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  plan_row vortex_record.storage_conversion_plans%rowtype;
  mapping_lock record;
  target_column_token text;
  changed_value boolean := false;
begin
  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      p_expected_plan_revision is not null
      and p_expected_plan_revision not between 1 and 9007199254740991
    ) then
    raise exception using errcode = '22023',
      message = 'Storage conversion allocation command is invalid';
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

  -- The same storage-lineage lock the provisioner takes, so staging a mapping
  -- and column never interleaves with a provision or a running batch.
  perform pg_catalog.pg_advisory_xact_lock(
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

  -- Lock both mappings in canonical field-id order, the same order the
  -- provisioner uses.
  for mapping_lock in
    select mapping.field_id
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = conversion.source_storage_contract_id
      and mapping.field_id in (conversion.source_field_id, conversion.target_field_id)
    order by mapping.field_id
    for update
  loop
    null;
  end loop;

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
  if found then
    if target_mapping.physical_column_token <> target_column_token
      or target_mapping.database_value_type <> conversion.target_database_value_type
      or target_mapping.state <> 'planned'
      or target_mapping.introduced_at_release_revision <> conversion.target_release_revision
      or vortex_record.field_storage_meaning(target_mapping.field_definition)
        is distinct from vortex_record.field_storage_meaning(
          conversion.target_field_definition
        ) then
      raise exception using errcode = '55000',
        message = 'Existing storage conversion target mapping is incompatible';
    end if;
  else
    -- Staging changes the Module's shared storage for every installation, so
    -- only the organisation that owns the Module may do it.
    if not (authority ->> 'ownsModule')::boolean then
      raise exception using errcode = '42501',
        message = 'Storage conversion staging requires the Module owner';
    end if;
    insert into vortex_record.field_storage_mappings (
      storage_contract_id, field_id, physical_column_token, database_value_type,
      field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
    ) values (
      conversion.source_storage_contract_id, conversion.target_field_id,
      target_column_token, conversion.target_database_value_type,
      conversion.target_field_definition, catalogue_row.module_root_id,
      conversion.target_release_revision, 'planned'
    );
    changed_value := true;
  end if;

  -- Physical `add`. The column is nullable; no active reader or writer selects
  -- it because its mapping is `planned`.
  perform vortex_record.ensure_storage_conversion_column_internal(
    catalogue_row.physical_table_token, target_column_token,
    conversion.target_database_value_type
  );

  select plan.* into plan_row
  from vortex_record.storage_conversion_plans as plan
  where plan.conversion_contract_id = p_conversion_contract_id
    and plan.organisation_id = organisation_id_value
    and plan.application_root_id is not distinct from scope_application_root_id
  for update;

  if found then
    if p_expected_plan_revision is not null
      and plan_row.plan_revision <> p_expected_plan_revision then
      raise exception using errcode = '40001',
        message = 'Storage conversion plan changed';
    end if;
  else
    if p_expected_plan_revision is not null then
      raise exception using errcode = '40001',
        message = 'Storage conversion plan is unavailable';
    end if;
    insert into vortex_record.storage_conversion_plans (
      conversion_contract_id, organisation_id, application_root_id, state,
      plan_revision, converted_count, last_record_id
    ) values (
      p_conversion_contract_id, organisation_id_value, scope_application_root_id,
      'planned', 1, 0, null
    )
    returning * into plan_row;
    changed_value := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'storageContractId', conversion.source_storage_contract_id,
    'sourceFieldId', conversion.source_field_id,
    'targetFieldId', conversion.target_field_id,
    'conversionSemantic', conversion.conversion_semantic,
    'sourceDatabaseValueType', conversion.source_database_value_type,
    'targetDatabaseValueType', conversion.target_database_value_type,
    'organisationId', organisation_id_value,
    'applicationRootId', scope_application_root_id,
    'state', plan_row.state,
    'planRevision', plan_row.plan_revision,
    'convertedCount', plan_row.converted_count,
    'changed', changed_value
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan evidence is unavailable';
end
$$;

COMMENT ON FUNCTION vortex_record.allocate_storage_conversion_plan(p_conversion_contract_id uuid, p_expected_plan_revision bigint) IS 'Opens one tenant-scoped plan, staging the planned target field mapping and column on first use without touching the active source mapping, so the installed release remains usable.';

REVOKE ALL ON FUNCTION vortex_record.allocate_storage_conversion_plan(p_conversion_contract_id uuid, p_expected_plan_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.allocate_storage_conversion_plan(p_conversion_contract_id uuid, p_expected_plan_revision bigint) TO vortex_request;
