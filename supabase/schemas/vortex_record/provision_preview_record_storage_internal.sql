create or replace function vortex_record.provision_preview_record_storage_internal(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_record_type jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_record_type jsonb;
  field_value jsonb;
  storage_id uuid;
  preview_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_index_columns text;
  index_token text;
  live_table_token text;
begin
  begin
    storage_id := (p_record_type ->> 'storageContractId')::uuid;
    record_type_id_value := (p_record_type ->> 'recordTypeId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
  end;
  storage_scope_value := p_record_type ->> 'storageScope';
  ownership_mode_value := p_record_type ->> 'ownershipMode';
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991
    or not vortex_platform.is_non_nil_uuid(storage_id::text)
    or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
    or p_record_type ? 'systemProjection'
    or storage_scope_value not in ('organization_shared', 'application_contained')
    or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
    or pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_record_type -> 'fields') < 1
    or pg_catalog.jsonb_typeof(p_record_type -> 'relationships') is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
  end if;

  preview_storage_id := pg_catalog.gen_random_uuid();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex_record.storage:' || preview_storage_id::text, 0)
  );
  table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(preview_storage_id::text), '-', '');
  preview_record_type := pg_catalog.jsonb_set(
    p_record_type,
    '{storageContractId}',
    pg_catalog.to_jsonb(preview_storage_id::text),
    true
  );
  shape_fingerprint := vortex_record.storage_meaning_fingerprint(preview_record_type);

  -- The live storage of this record type, when it has any: the builder's readable records are
  -- seeded from it after provisioning, under the builder's own live access.
  select catalogue.physical_table_token into live_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = storage_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  perform vortex_record.create_record_storage_table_internal(
    preview_storage_id, p_module_root_id, record_type_id_value,
    storage_scope_value, ownership_mode_value
  );
  insert into vortex_record.storage_catalogue (
    storage_contract_id, physical_schema_token, physical_table_token,
    module_root_id, record_type_id, storage_scope,
    first_compatible_release_revision, last_compatible_release_revision,
    state, content_fingerprint, record_type_definition, protected_read_model_key
  ) values (
    preview_storage_id, 'record_data', table_token,
    p_module_root_id, record_type_id_value, storage_scope_value,
    p_module_release_revision, p_module_release_revision,
    'active', shape_fingerprint, preview_record_type, null
  );

  for field_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    begin
      field_id_value := (field_value ->> 'fieldId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or field_value ->> 'type' is null
      or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
      or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
      raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
    end if;
    column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
    database_type := vortex_record.database_value_type(field_value);
    if database_type is null then
      raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
    end if;
    sql_type := vortex_record.sql_value_type(database_type);
    execute pg_catalog.format(
      'alter table record_data.%I add column %I %s%s',
      table_token, column_token, sql_type,
      -- Copied live records have no value for a field the draft adds, so only fresh storage
      -- enforces a required field in the table; the save path enforces it for every record.
      case when (field_value ->> 'required')::boolean and live_table_token is null
        then ' not null' else '' end
    );
    insert into vortex_record.field_storage_mappings (
      storage_contract_id, field_id, physical_column_token, database_value_type,
      field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
    ) values (
      preview_storage_id, field_id_value, column_token, database_type, field_value,
      p_module_root_id, p_module_release_revision, 'active'
    );
    if (field_value ->> 'unique')::boolean then
      scope_index_columns := case storage_scope_value
        when 'organization_shared' then 'organisation_id'
        else 'organisation_id, application_root_id'
      end;
      index_token := 'pux_' || pg_catalog.md5(
        preview_storage_id::text || ':' || field_id_value::text
      );
      execute pg_catalog.format(
        'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
        index_token, table_token, scope_index_columns, column_token
      );
    end if;
  end loop;

  insert into vortex_record.preview_storage_bindings (
    preview_installation_id, storage_contract_id, module_root_id,
    module_release_revision, record_type_id, release_storage_contract_id
  ) values (
    p_preview_installation_id, preview_storage_id, p_module_root_id,
    p_module_release_revision, record_type_id_value, storage_id
  );
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'moduleReleaseRevision', p_module_release_revision,
    'recordTypeId', record_type_id_value,
    'releaseStorageContractId', storage_id,
    'previewStorageContractId', preview_storage_id
  );
end
$function$;

alter function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb)
  to vortex_owner;
comment on function vortex_record.provision_preview_record_storage_internal(uuid, uuid, bigint, jsonb) is
  'Creates empty isolated Record storage for one record type of an exact Module release a preview runs, and returns its storage identity: the release storage it stands for and its own.';
