create or replace function vortex_record.read_search_index_record_internal(
  p_trusted_source_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  plan jsonb := p_trusted_source_plan;
  context_value jsonb;
  authority jsonb;
  occurrence jsonb;
  module_release vortex_definition.releases%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  provision_row vortex_record.release_provisions%rowtype;
  record_type jsonb;
  record_types jsonb;
  selected_field jsonb;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  selected_field_id uuid;
  selected_field_ids uuid[] := array[]::uuid[];
  field_value_pairs text[] := array[]::text[];
  field_value_sql text;
  selected_module_root_id uuid;
  selected_module_release_revision bigint;
  selected_application_release_revision bigint;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_record_type_id uuid;
  selected_record_id uuid;
  selected_storage_contract_id uuid;
  selected_occurrence_id uuid;
  selected_claim_cursor uuid;
  physical_table text;
  physical_column text;
  record_row record;
  row_count integer;
begin
  if pg_catalog.jsonb_typeof(plan) is distinct from 'object'
    or not plan ?& array[
      'occurrenceId', 'claimCursor', 'organizationId', 'applicationRootId',
      'applicationReleaseRevision', 'moduleRootId', 'moduleReleaseRevision',
      'bindingRevision', 'storageContractId', 'recordTypeId', 'recordId',
      'recordType', 'fieldIds'
    ]
    or plan - array[
      'occurrenceId', 'claimCursor', 'organizationId', 'applicationRootId',
      'applicationReleaseRevision', 'moduleRootId', 'moduleReleaseRevision',
      'bindingRevision', 'storageContractId', 'recordTypeId', 'recordId',
      'recordType', 'fieldIds'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(plan -> 'fieldIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(plan -> 'recordType') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Search Record plan is invalid';
  end if;

  selected_occurrence_id := (plan ->> 'occurrenceId')::uuid;
  selected_claim_cursor := (plan ->> 'claimCursor')::uuid;
  selected_organization_id := (plan ->> 'organizationId')::uuid;
  selected_application_root_id := (plan ->> 'applicationRootId')::uuid;
  selected_application_release_revision := (plan ->> 'applicationReleaseRevision')::bigint;
  selected_module_root_id := (plan ->> 'moduleRootId')::uuid;
  selected_module_release_revision := (plan ->> 'moduleReleaseRevision')::bigint;
  selected_record_type_id := (plan ->> 'recordTypeId')::uuid;
  selected_record_id := (plan ->> 'recordId')::uuid;
  selected_storage_contract_id := (plan ->> 'storageContractId')::uuid;

  if selected_occurrence_id is null or selected_occurrence_id = nil_uuid
    or selected_claim_cursor is null or selected_claim_cursor = nil_uuid
    or selected_organization_id is null or selected_organization_id = nil_uuid
    or selected_application_root_id is null or selected_application_root_id = nil_uuid
    or selected_module_root_id is null or selected_module_root_id = nil_uuid
    or selected_record_type_id is null or selected_record_type_id = nil_uuid
    or selected_record_id is null or selected_record_id = nil_uuid
    or selected_storage_contract_id is null or selected_storage_contract_id = nil_uuid
    or selected_application_release_revision not between 1 and 9007199254740991
    or selected_module_release_revision not between 1 and 9007199254740991
    or (plan ->> 'bindingRevision')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Search Record plan identity is invalid';
  end if;

  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or context_value ->> 'channel' is distinct from 'system'
    or context_value ? 'supportContext'
    or context_value ->> 'organizationId' is distinct from selected_organization_id::text
    or context_value ->> 'applicationRootId' is distinct from selected_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search Record authority is unavailable';
  end if;
  authority := vortex_access.validated_search_index_request_context_internal(
    selected_occurrence_id, selected_claim_cursor
  );
  occurrence := authority -> 'occurrence';
  if authority ->> 'organizationId' is distinct from selected_organization_id::text
    or authority ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or authority ->> 'storageContractId' is distinct from selected_storage_contract_id::text
    or authority ->> 'storageScope' is distinct from 'application_contained'
    or occurrence ->> 'recordId' is distinct from selected_record_id::text
    or occurrence #>> '{descriptor,recordTypeId}' is distinct from selected_record_type_id::text
    or occurrence #>> '{installation,moduleBinding,moduleRootId}' is distinct from selected_module_root_id::text
    or occurrence #>> '{definitionRelease,kind}' is distinct from 'module'
    or occurrence #>> '{definitionRelease,rootId}' is distinct from selected_module_root_id::text
    or occurrence #>> '{definitionRelease,releaseRevision}' is distinct from
      occurrence #>> '{installation,moduleBinding,moduleReleaseRevision}'
    or occurrence #>> '{installation,applicationRootId}' is distinct from selected_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search Record claim or source changed';
  end if;

  select release.* into module_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_module_root_id
    and release.release_revision = selected_module_release_revision
    and root.kind = 'module';
  if not found
    or module_release.source_contract_version is distinct from module_release.validation_contract_version
    or module_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('module'))
    or module_release.compilation_output #>> '{kind}' is distinct from 'module'
    or module_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_module_root_id::text
    or module_release.compilation_output #>> '{validationContractVersion}'
      is distinct from module_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search Record release is unavailable';
  end if;

  record_types := module_release.compilation_output #> '{canonical,content,recordTypes}';
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(record_types) as item(value)
  where item.value ->> 'recordTypeId' = selected_record_type_id::text
    and item.value ->> 'storageContractId' = selected_storage_contract_id::text;
  if not found or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where item.value ->> 'recordTypeId' = selected_record_type_id::text
      and item.value ->> 'storageContractId' = selected_storage_contract_id::text
  ) <> 1
    or record_type is distinct from plan -> 'recordType'
    or record_type ->> 'storageScope' is distinct from 'application_contained' then
    raise exception using errcode = '42501', message = 'Search Record type is unavailable';
  end if;

  select provision.* into provision_row
  from vortex_record.release_provisions as provision
  where provision.module_root_id = selected_module_root_id
    and provision.release_revision = selected_module_release_revision;
  if not found
    or provision_row.content_fingerprint is distinct from module_release.content_fingerprint
    or provision_row.resolution_fingerprint is distinct from module_release.resolution_fingerprint
    or not selected_storage_contract_id = any (provision_row.storage_contract_ids) then
    raise exception using errcode = '42501', message = 'Search Record provision is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = selected_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data'
    or catalogue_row.module_root_id is distinct from selected_module_root_id
    or catalogue_row.record_type_id is distinct from selected_record_type_id
    or catalogue_row.storage_scope is distinct from 'application_contained'
    or selected_module_release_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null and
      selected_module_release_revision > catalogue_row.last_compatible_release_revision)
    or vortex_record.storage_meaning(catalogue_row.record_type_definition)
      is distinct from vortex_record.storage_meaning(record_type) then
    raise exception using errcode = '42501', message = 'Search Record storage is unavailable';
  end if;
  physical_table := catalogue_row.physical_table_token;
  if physical_table is null or physical_table !~ '^rt_[a-f0-9]{32}$'
    or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', physical_table)) is null then
    raise exception using errcode = '42501', message = 'Search Record storage is unavailable';
  end if;

  for selected_field in
    select item.value
    from pg_catalog.jsonb_array_elements(plan -> 'fieldIds') as item(value)
    order by item.value #>> '{}' collate "C"
  loop
    begin
      selected_field_id := (selected_field #>> '{}')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Search field identity is invalid';
    end;
    if selected_field_id is null or selected_field_id = nil_uuid
      or selected_field_id = any (selected_field_ids) then
      raise exception using errcode = '42501', message = 'Search field identity is invalid';
    end if;
    selected_field_ids := selected_field_ids || selected_field_id;

    select field.value into selected_field
    from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
    where field.value ->> 'fieldId' = selected_field_id::text;
    if not found
      or selected_field ->> 'personalData' is distinct from 'none'
      or selected_field ->> 'searchPriority' not in ('first', 'normal', 'last')
      or selected_field ->> 'type' not in (
        'text', 'long_text', 'formatted_text', 'whole_number', 'decimal_number', 'date',
        'date_time', 'choice', 'several_choices', 'reference_number', 'email_address',
        'phone_number', 'web_address'
      ) then
      raise exception using errcode = '42501', message = 'Search field is not directly disclosable';
    end if;

    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = selected_storage_contract_id
      and mapping.field_id = selected_field_id
      and mapping.state = 'active';
    if not found
      or mapping_row.field_definition is distinct from selected_field
      or mapping_row.physical_column_token is distinct from
        ('f_' || pg_catalog.replace(pg_catalog.lower(selected_field_id::text), '-', ''))
      or mapping_row.database_value_type is distinct from
        vortex_record.database_value_type(selected_field)
      or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', physical_table)) is null
      or not exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('%I.%I', 'record_data', physical_table)
          )
          and attribute.attname = mapping_row.physical_column_token
          and attribute.attnum > 0
          and not attribute.attisdropped
      ) then
      raise exception using errcode = '42501', message = 'Search field storage is unavailable';
    end if;

    physical_column := mapping_row.physical_column_token;
    field_value_sql := case mapping_row.database_value_type
      when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', physical_column)
      when 'date' then pg_catalog.format(
        'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))', physical_column
      )
      when 'timestamp_with_time_zone' then pg_catalog.format(
        'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.%I))', physical_column
      )
      else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', physical_column)
    end;
    field_value_pairs := pg_catalog.array_append(
      field_value_pairs,
      pg_catalog.format('%L, %s', selected_field_id::text, field_value_sql)
    );
  end loop;

  if pg_catalog.cardinality(selected_field_ids) > 100 then
    raise exception using errcode = '42501', message = 'Search field count is out of bounds';
  end if;

  execute pg_catalog.format(
    'select stored.organisation_id, stored.application_root_id, stored.module_root_id,
       stored.record_type_id, stored.storage_contract_id, stored.record_id,
       stored.definition_revision, stored.concurrency_number, stored.lifecycle_state,
       pg_catalog.jsonb_build_object(%s) as field_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.application_root_id = $2
       and stored.record_id = $3
       and stored.module_root_id = $4
       and stored.record_type_id = $5
       and stored.storage_contract_id = $6
     for update of stored',
    case when pg_catalog.cardinality(field_value_pairs) = 0 then ''
      else pg_catalog.array_to_string(field_value_pairs, ', ') end,
    physical_table
  ) into record_row
  using selected_organization_id, selected_application_root_id, selected_record_id,
    selected_module_root_id, selected_record_type_id, selected_storage_contract_id;
  get diagnostics row_count = ROW_COUNT;
  if row_count <> 1 or record_row.record_id is null
    or record_row.organisation_id is distinct from selected_organization_id
    or record_row.application_root_id is distinct from selected_application_root_id
    or record_row.module_root_id is distinct from selected_module_root_id
    or record_row.record_type_id is distinct from selected_record_type_id
    or record_row.storage_contract_id is distinct from selected_storage_contract_id
    or record_row.definition_revision not between catalogue_row.first_compatible_release_revision and
      coalesce(catalogue_row.last_compatible_release_revision, 9007199254740991)
    or record_row.concurrency_number not between 1 and 9007199254740991
    or record_row.lifecycle_state not in ('active', 'soft_deleted', 'removal_pending') then
    raise exception using errcode = 'P0002', message = 'Search current Record is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'indexOrganisationId', selected_organization_id,
    'ownerOrganisationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'recordTypeId', selected_record_type_id,
    'recordId', selected_record_id,
    'definitionRevision', record_row.definition_revision,
    'recordVersion', record_row.concurrency_number,
    'lifecycle', case when record_row.lifecycle_state = 'active' then 'active' else 'deleted' end,
    'fieldValues', case when record_row.lifecycle_state = 'active'
      then record_row.field_values else '{}'::jsonb end
  );
end
$function$;

alter function vortex_record.read_search_index_record_internal(jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.read_search_index_record_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner,
    vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_record.read_search_index_record_internal(jsonb)
  to vortex_module_owner;
comment on function vortex_record.read_search_index_record_internal(jsonb) is
  'Returns one locked current application-contained Record Search snapshot to the Module owner only, deriving physical storage from current immutable provision and catalogue metadata while preserving generated Record RLS.';
