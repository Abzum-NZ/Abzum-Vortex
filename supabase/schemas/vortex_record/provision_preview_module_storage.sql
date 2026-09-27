create or replace function vortex_record.provision_preview_module_storage(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
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
  storage_identities jsonb := '[]'::jsonb;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Preview storage selector is invalid';
  end if;
  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;
  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where item.value ->> 'storageContractId' is null
      or item.value ->> 'recordTypeId' is null
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_context.is_non_nil_uuid(storage_id::text)
      or not vortex_context.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;

    preview_storage_id := pg_catalog.gen_random_uuid();
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || preview_storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(preview_storage_id::text), '-', '');
    preview_record_type := pg_catalog.jsonb_set(
      record_type,
      '{storageContractId}',
      pg_catalog.to_jsonb(preview_storage_id::text),
      true
    );
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(preview_record_type);

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
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_context.is_non_nil_uuid(field_id_value::text)
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
        case when (field_value ->> 'required')::boolean then ' not null' else '' end
      );
      insert into vortex_record.field_storage_mappings (
        storage_contract_id, field_id, physical_column_token, database_value_type,
        field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
      ) values (
        preview_storage_id, field_id_value, column_token, database_type, field_value,
        p_module_root_id, p_module_release_revision, 'active'
      );
      if not (record_type ? 'systemProjection')
        and (field_value ->> 'unique')::boolean then
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
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id,
        'moduleReleaseRevision', p_module_release_revision,
        'recordTypeId', record_type_id_value,
        'releaseStorageContractId', storage_id,
        'previewStorageContractId', preview_storage_id
      )
    );
  end loop;
  return storage_identities;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Exact Module release is ambiguous';
end
$function$;

revoke all on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  to vortex_module_owner;
comment on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint) is
  'Creates fresh empty Record storage for every record type in one exact published Module release, without provisioning its live release identities.';
