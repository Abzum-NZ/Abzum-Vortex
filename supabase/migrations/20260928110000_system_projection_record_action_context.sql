-- Keep action resolution aligned with the registered protected-view and action contract used by reads.
set local role vortex_record_adapter;

create or replace function vortex_record.resolve_record_action_context_internal(
  p_record_type_id uuid,
  p_action_kind text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  application_root_id_value uuid;
  installation jsonb;
  binding_item jsonb;
  module_content jsonb;
  application_content jsonb;
  module_root_id_value uuid;
  module_release_revision_value bigint;
  record_type_value jsonb;
  candidate_record_type_value jsonb;
  target_module_root_id uuid;
  target_release_revision bigint;
  target_storage_contract_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  field_item jsonb;
  field_mapping vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb := '{}'::jsonb;
  required_permissions jsonb := '[]'::jsonb;
  permission_item jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore') then
    raise exception using errcode = '22023', message = 'Record action selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record action requires an application context';
  end if;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  installation := vortex_module.read_current_active_installation();

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_id_value := (binding_item ->> 'moduleRootId')::uuid;
    module_release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;
    select release.compilation_output #> '{canonical,content}' into strict module_content
    from vortex_definition.releases as release
    where release.root_id = module_root_id_value
      and release.release_revision = module_release_revision_value;

    select item.value into candidate_record_type_value
    from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if found then
      if target_module_root_id is not null then
        raise exception using errcode = '55000',
          message = 'Installed record type identity is ambiguous';
      end if;
      target_module_root_id := module_root_id_value;
      target_release_revision := module_release_revision_value;
      record_type_value := candidate_record_type_value;
      target_storage_contract_id := (record_type_value ->> 'storageContractId')::uuid;
      for permission_item in
        select item.value
        from pg_catalog.jsonb_array_elements(
          coalesce(module_content -> 'permissions', '[]'::jsonb)
        ) as item(value)
        where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
          and item.value ->> 'actionKind' = p_action_kind
          and (item.value ->> 'namedAction') is null
      loop
        required_permissions := required_permissions || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'applicationRootId', application_root_id_value,
            'ownerKind', 'module', 'ownerId', target_module_root_id,
            'permissionId', (permission_item ->> 'permissionId')::uuid
          )
        );
      end loop;
    end if;
  end loop;

  if target_module_root_id is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = target_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_value ->> 'storageScope')
    or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
    or (catalogue_row.physical_schema_token = 'system_projection')
      is distinct from (record_type_value ? 'systemProjection')
    or (catalogue_row.physical_schema_token = 'system_projection'
      and catalogue_row.protected_read_model_key
        is distinct from (record_type_value #>> '{systemProjection,protectedView}'))
    or (catalogue_row.physical_schema_token = 'system_projection'
      and not coalesce(
        (record_type_value #> '{standardActions}') ? p_action_kind,
        false
      ))
    or not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = target_module_root_id
        and provision.release_revision = target_release_revision
        and target_storage_contract_id = any (provision.storage_contract_ids)
    ) then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the active installation';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
  loop
    select mapping.* into field_mapping
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = target_storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid;
    if not found or field_mapping.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record field storage disagrees with the active installation';
    end if;
    columns_value := columns_value || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'),
      pg_catalog.jsonb_build_object(
        'token', field_mapping.physical_column_token,
        'databaseValueType', field_mapping.database_value_type,
        'type', field_item ->> 'type',
        'required', field_item -> 'required',
        'settings', field_item -> 'settings'
      )
    );
  end loop;

  select release.compilation_output #> '{canonical,content}' into strict application_content
  from vortex_definition.releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
      and item.value ->> 'actionKind' = p_action_kind
      and (item.value ->> 'namedAction') is null
  loop
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_root_id_value,
        'ownerKind', 'application', 'ownerId', application_root_id_value,
        'permissionId', (permission_item ->> 'permissionId')::uuid
      )
    );
  end loop;

  required_permissions := coalesce((
    select pg_catalog.jsonb_agg(item.value order by
      item.value ->> 'ownerKind' collate "C", item.value ->> 'permissionId' collate "C")
    from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'context', context_value,
    'recordType', record_type_value,
    'moduleRootId', target_module_root_id,
    'moduleReleaseRevision', target_release_revision,
    'storageContractId', target_storage_contract_id,
    'storageScope', record_type_value ->> 'storageScope',
    'table', catalogue_row.physical_table_token,
    'columns', columns_value,
    'declaration', case when pg_catalog.jsonb_array_length(required_permissions) = 0 then null
      else pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      ) end
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is ambiguous';
end
$function$;

revoke all on function vortex_record.resolve_record_action_context_internal(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.resolve_record_action_context_internal(uuid, text) is
  'Private installed-record action resolver: validates catalogue, release, field, and protected system-projection evidence before returning action metadata.';


reset role;
