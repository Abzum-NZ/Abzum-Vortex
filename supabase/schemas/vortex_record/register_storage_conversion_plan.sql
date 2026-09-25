create or replace function vortex_record.register_storage_conversion_plan(
  p_source_storage_contract_id uuid,
  p_source_field_id uuid,
  p_target_field_id uuid,
  p_source_release_revision bigint,
  p_target_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  source_release vortex_definition.releases%rowtype;
  target_release vortex_definition.releases%rowtype;
  source_record_types jsonb;
  target_record_types jsonb;
  source_field jsonb;
  target_field jsonb;
  semantic text;
  conversion_id uuid;
  inserted_count integer;
  stored vortex_record.storage_conversion_catalogue%rowtype;
begin
  if p_source_storage_contract_id is null
    or p_source_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_field_id is null
    or p_source_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_field_id is null
    or p_target_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_field_id = p_target_field_id
    or p_source_release_revision is null
    or p_source_release_revision not between 1 and 9007199254740991
    or p_target_release_revision is null
    or p_target_release_revision not between 1 and 9007199254740991
    or p_target_release_revision <= p_source_release_revision then
    raise exception using errcode = '22023',
      message = 'Storage conversion registration command is invalid';
  end if;

  authority := vortex_record.authorize_storage_conversion_internal(
    p_source_storage_contract_id, null
  );
  if not (authority ->> 'ownsModule')::boolean then
    raise exception using errcode = '42501',
      message = 'Storage conversion registration requires the Module owner';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_source_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or p_source_release_revision < catalogue_row.first_compatible_release_revision
    or (
      catalogue_row.last_compatible_release_revision is not null
      and p_source_release_revision > catalogue_row.last_compatible_release_revision
    ) then
    raise exception using errcode = '55000',
      message = 'Storage conversion source contract is unavailable';
  end if;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_source_storage_contract_id
    and mapping.field_id = p_source_field_id;
  if not found or source_mapping.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion source field is not active';
  end if;

  -- A target field that is already stored (active or retired) is not a
  -- conversion target; only an absent or already-planned target qualifies.
  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_source_storage_contract_id
    and mapping.field_id = p_target_field_id;
  if found and target_mapping.state <> 'planned' then
    raise exception using errcode = '55000',
      message = 'Storage conversion target field is already stored';
  end if;

  select release.* into source_release
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = p_source_release_revision;
  if not found
    or source_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('module_storage_conversion'))
    or source_release.compilation_output #>> '{kind}' <> 'module'
    or source_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> catalogue_row.module_root_id::text
    or source_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('module_storage_conversion')) then
    raise exception using errcode = '23514',
      message = 'Exact storage conversion source release is incompatible';
  end if;

  select release.* into target_release
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = p_target_release_revision;
  if not found
    or target_release.validation_contract_version <> all (vortex_definition.accepted_contract_version('module_storage_conversion'))
    or target_release.compilation_output #>> '{kind}' <> 'module'
    or target_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> catalogue_row.module_root_id::text
    or target_release.compilation_output #>> '{validationContractVersion}' <> all (vortex_definition.accepted_contract_version('module_storage_conversion')) then
    raise exception using errcode = '23514',
      message = 'Exact storage conversion target release is incompatible';
  end if;

  source_record_types := source_release.compilation_output
    #> '{canonical,content,recordTypes}';
  target_record_types := target_release.compilation_output
    #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(source_record_types) is distinct from 'array'
    or pg_catalog.jsonb_typeof(target_record_types) is distinct from 'array' then
    raise exception using errcode = '23514',
      message = 'Storage conversion release content is incompatible';
  end if;

  select field_item.value into source_field
  from pg_catalog.jsonb_array_elements(source_record_types) as record_item(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    record_item.value -> 'fields'
  ) as field_item(value)
  where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
    and (field_item.value ->> 'fieldId')::uuid = p_source_field_id;
  if source_field is null
    or vortex_record.database_value_type(source_field)
      is distinct from source_mapping.database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion source field evidence is incompatible';
  end if;

  select field_item.value into target_field
  from pg_catalog.jsonb_array_elements(target_record_types) as record_item(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    record_item.value -> 'fields'
  ) as field_item(value)
  where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
    and (field_item.value ->> 'fieldId')::uuid = p_target_field_id;
  if target_field is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion target field is not published';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(source_record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as field_item(value)
    where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
      and (field_item.value ->> 'fieldId')::uuid = p_target_field_id
  ) then
    raise exception using errcode = '23514',
      message = 'Storage conversion target field already exists in the source release';
  end if;

  semantic := vortex_record.conversion_semantic_for_fields(source_field, target_field);
  if semantic is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion pair is unsupported';
  end if;

  conversion_id := vortex_record.storage_conversion_contract_identity(
    p_source_storage_contract_id, p_source_field_id, p_target_field_id
  );

  insert into vortex_record.storage_conversion_catalogue (
    conversion_contract_id, source_storage_contract_id, target_storage_contract_id,
    source_field_id, target_field_id, source_database_value_type,
    target_database_value_type, conversion_semantic, source_release_revision,
    target_release_revision, source_field_definition, target_field_definition
  ) values (
    conversion_id, p_source_storage_contract_id, p_source_storage_contract_id,
    p_source_field_id, p_target_field_id, source_mapping.database_value_type,
    vortex_record.database_value_type(target_field), semantic,
    p_source_release_revision, p_target_release_revision, source_field, target_field
  )
  on conflict (conversion_contract_id) do nothing;
  get diagnostics inserted_count = row_count;

  select stored_entry.* into stored
  from vortex_record.storage_conversion_catalogue as stored_entry
  where stored_entry.conversion_contract_id = conversion_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion catalogue write failed';
  end if;

  -- An entry is immutable once registered: a plan, its staged mapping and its
  -- progress all depend on exactly this evidence.
  if inserted_count = 0 and (
    stored.source_database_value_type is distinct from source_mapping.database_value_type
    or stored.target_database_value_type
      is distinct from vortex_record.database_value_type(target_field)
    or stored.conversion_semantic is distinct from semantic
    or stored.source_release_revision is distinct from p_source_release_revision
    or stored.target_release_revision is distinct from p_target_release_revision
    or stored.source_field_definition is distinct from source_field
    or stored.target_field_definition is distinct from target_field
  ) then
    raise exception using errcode = '55000',
      message = 'Storage conversion is already registered with different evidence';
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', stored.conversion_contract_id,
    'storageContractId', stored.source_storage_contract_id,
    'sourceFieldId', stored.source_field_id,
    'targetFieldId', stored.target_field_id,
    'conversionSemantic', stored.conversion_semantic,
    'sourceDatabaseValueType', stored.source_database_value_type,
    'targetDatabaseValueType', stored.target_database_value_type,
    'sourceReleaseRevision', stored.source_release_revision,
    'targetReleaseRevision', stored.target_release_revision,
    'changed', inserted_count > 0
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion release evidence is unavailable';
end
$function$;

revoke all on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) to vortex_request;
comment on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) is
  'Records one immutable conversion catalogue entry from the caller-owned Module''s exact published source mapping and target release evidence; refuses any caller-authored type or unsupported pair.';
