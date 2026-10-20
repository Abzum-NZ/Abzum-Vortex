set local role vortex_record_adapter;

create or replace function vortex_record.with_installed_record_contributions_internal(
  p_content jsonb,
  p_organization_id uuid,
  p_module_root_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  record_type_item jsonb;
  record_types jsonb := '[]'::jsonb;
  contributed jsonb;
begin
  if p_content is null or pg_catalog.jsonb_typeof(p_content -> 'recordTypes') is distinct from 'array' then
    return p_content;
  end if;

  -- The one place an installed Module release's record types gain the fields other installed
  -- Modules contributed to them: every reader and writer of an owner record builds its record
  -- type from the release content through here, so an owner record has one effective field list.
  -- A contributed field whose identity or key the owner already uses is left out.
  for record_type_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_content -> 'recordTypes')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    contributed := '[]'::jsonb;
    if not record_type_item ? 'systemProjection' then
      select coalesce(pg_catalog.jsonb_agg(entry.value -> 'field' order by entry.ordinality), '[]'::jsonb)
      into contributed
      from pg_catalog.jsonb_array_elements(
        vortex_record.installed_record_type_contributions_internal(
          p_organization_id, p_module_root_id, (record_type_item ->> 'storageContractId')::uuid
        )
      ) with ordinality as entry(value, ordinality)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as own(value)
        where pg_catalog.lower(own.value ->> 'fieldId') = pg_catalog.lower(entry.value #>> '{field,fieldId}')
          or own.value ->> 'key' = entry.value #>> '{field,key}'
      );
    end if;
    record_types := record_types || pg_catalog.jsonb_build_array(
      case when contributed = '[]'::jsonb then record_type_item
        else pg_catalog.jsonb_set(
          record_type_item, '{fields}', (record_type_item -> 'fields') || contributed
        ) end
    );
  end loop;
  return pg_catalog.jsonb_set(p_content, '{recordTypes}', record_types);
end
$function$;

alter function vortex_record.with_installed_record_contributions_internal(jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.with_installed_record_contributions_internal(jsonb, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.with_installed_record_contributions_internal(jsonb, uuid, uuid)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.with_installed_record_contributions_internal(jsonb, uuid, uuid) is
  'Private installed Module content with each record type''s fields extended by the fields other installed Modules of the organisation contributed to it. The one effective field list every record reader and writer builds from.';

create or replace function vortex_record.resolve_installation_access_plan_internal(
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  none_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  plan_key_value text;
  cached_plan jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  preview_installation_id_value uuid;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  release_storage_contract_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  plan jsonb;
  cacheable boolean;
  contribution_pins text := '';
begin
  -- The plan is keyed by the exact installation pins. A binding revision is
  -- advanced by every installation lifecycle transition, and a release revision
  -- is immutable, so any change to definitions, bindings, permissions or saved
  -- conditions yields a different key and therefore a different plan. A plan
  -- that no longer matches the live pins can never be selected. The plan holds
  -- declared requirements only: role grants and every other decision input are
  -- read live by Access, never from the plan.
  if p_installation is null
    or pg_catalog.jsonb_typeof(p_installation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_installation -> 'moduleBindings') is distinct from 'array'
    or (p_installation ->> 'organizationId') is null
    or (p_installation ->> 'applicationRootId') is null
    or (p_installation ->> 'applicationReleaseRevision') is null
    or (p_installation ? 'previewInstallationId'
      and pg_catalog.jsonb_typeof(p_installation -> 'storageIdentities') is distinct from 'array')
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ]
    ) then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  organization_id_value := (p_installation ->> 'organizationId')::uuid;
  application_root_id_value := (p_installation ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (p_installation ->> 'applicationReleaseRevision')::bigint;
  preview_installation_id_value := case
    when p_installation ? 'previewInstallationId'
      then (p_installation ->> 'previewInstallationId')::uuid
    else null
  end;
  if organization_id_value = none_uuid
    or application_root_id_value = none_uuid
    or application_release_revision_value not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  -- The fields other installed Modules contributed to the pinned Modules' record types are part
  -- of what the plan holds, so their exact pins are part of its key. A preview runs its own
  -- storage and receives no contributions.
  if preview_installation_id_value is null then
    contribution_pins := vortex_record.installed_contribution_pins_internal(
      organization_id_value,
      array(
        select (item.value ->> 'moduleRootId')::uuid
        from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
      )
    );
  end if;

  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      organization_id_value::text || '|' || application_root_id_value::text || '|'
        || application_release_revision_value::text || '|'
        || case when preview_installation_id_value is null then ''
          else preview_installation_id_value::text || '|' end
        || contribution_pins || '|' || coalesce((
          select pg_catalog.string_agg(
            (item.value ->> 'moduleRootId') || ':'
              || (item.value ->> 'moduleReleaseRevision') || ':'
              || (item.value ->> 'bindingRevision') || ':'
              || (item.value ->> 'state'),
            ',' order by (item.value ->> 'moduleRootId') collate "C"
          )
          from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
        ), ''),
      'UTF8'
    )),
    'hex'
  );

  -- Only an all-active pin set is cached. The storage catalogue and field
  -- mappings the plan resolves are not part of the key; storage adoption can
  -- retire a field mapping only while no provisioned or active binding pins a
  -- release that declares the field, so an active plan's mappings cannot
  -- change under it. A detached binding is not counted there, so a detached
  -- pin set is resolved afresh on every call and still refuses a retired
  -- mapping exactly as before.
  cacheable := preview_installation_id_value is null and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'state') is distinct from 'active'
  );

  if cacheable then
    select stored.plan into cached_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value;
    if cached_plan is not null then
      return cached_plan;
    end if;
  end if;

  -- Step 1: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    -- Canonical binding order, so the plan content never depends on the order
    -- a caller happened to supply and always matches the plan key's order.
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.runtime_releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;
    if preview_installation_id_value is null then
      release_content := vortex_record.with_installed_record_contributions_internal(
        release_content, organization_id_value, module_root_value
      );
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      release_storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;
      -- A preview isolates its record storage; a system projection is read as it is.
      if preview_installation_id_value is null or record_type_item ? 'systemProjection' then
        storage_contract_value := release_storage_contract_value;
      else
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict storage_contract_value
        from pg_catalog.jsonb_array_elements(p_installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = module_root_value
          and (binding.value ->> 'moduleReleaseRevision')::bigint = release_revision_value
          and (binding.value ->> 'recordTypeId')::uuid = record_type_id_value
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_value;
        if not found then
          raise exception using errcode = '55000',
            message = 'Preview Record storage disagrees with its exact Module release';
        end if;
      end if;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        -- A system projection is read only through the protected reader
        -- registered for exactly the key its installed definition declares (the
        -- catalogue key references the closed registry); a generated record
        -- type is never read through a projection, and a disagreeing key
        -- refuses.
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}'))
        or (preview_installation_id_value is null and not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and release_storage_contract_value = any (provision.storage_contract_ids)
        )) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(%I))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'isSystemProjection', record_type_item ? 'systemProjection',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.runtime_releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = application_release_revision_value;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', application_root_id_value,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  plan := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'applicationReleaseRevision', application_release_revision_value,
    'recordTypes', type_meta,
    'relationships', relationship_by_id,
    'sharingConditions', condition_list,
    'permissions', permission_by_id
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;

  if not cacheable then
    return plan;
  end if;

  -- A concurrent builder may have stored the same plan first. Both were built
  -- from the same immutable pins, so either row is the same plan; this call's
  -- own plan is returned when that row is not yet visible to its snapshot.
  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id,
    application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, plan
  )
  on conflict (plan_key) do nothing;

  select stored.plan into cached_plan
  from vortex_record.installation_access_plans as stored
  where stored.plan_key = plan_key_value;
  return coalesce(cached_plan, plan);
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.resolve_installation_access_plan_internal(jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.resolve_installation_access_plan_internal(jsonb) is
  'Private installation access plan builder and cache: resolves definitions, column maps, permission alternatives and saved conditions once per all-active installation binding revision; a detached pin set is resolved afresh.';

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
  preview_installation jsonb;
  preview_installation_id_value uuid;
  binding_item jsonb;
  module_content jsonb;
  application_content jsonb;
  module_root_id_value uuid;
  module_release_revision_value bigint;
  record_type_value jsonb;
  candidate_record_type_value jsonb;
  release_storage_contract_id uuid;
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
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore') then
    raise exception using errcode = '22023', message = 'Record action selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record action requires an application context';
  end if;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    if preview_installation ->> 'outcome' = 'refused'
      or p_action_kind not in ('create', 'read', 'update') then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    installation := preview_installation;
    preview_installation_id_value :=
      (preview_installation ->> 'previewInstallationId')::uuid;
  else
    installation := vortex_definition.read_current_active_installation();
  end if;

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_id_value := (binding_item ->> 'moduleRootId')::uuid;
    module_release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = module_root_id_value
      and release.release_revision = module_release_revision_value;
    -- The owner record type this action context resolves carries the fields other installed
    -- Modules contributed to it; a preview runs its own storage and receives none.
    if preview_installation_id_value is null then
      module_content := vortex_record.with_installed_record_contributions_internal(
        module_content, (context_value ->> 'organizationId')::uuid, module_root_id_value
      );
    end if;

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
      release_storage_contract_id := (record_type_value ->> 'storageContractId')::uuid;
      target_storage_contract_id := release_storage_contract_id;
      if preview_installation_id_value is not null
        and not (record_type_value ? 'systemProjection') then
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict target_storage_contract_id
        from pg_catalog.jsonb_array_elements(installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = target_module_root_id
          and (binding.value ->> 'moduleReleaseRevision')::bigint = target_release_revision
          and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_id;
        if not found then
          return pg_catalog.jsonb_build_object('outcome', 'refused');
        end if;
      end if;
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
  -- A system projection is the platform's live read model and has no preview copy: a preview
  -- reads it on the live path, under the reader's own live access, never as the preview's owner,
  -- and never changes it.
  if record_type_value ? 'systemProjection' then
    if preview_installation is not null and p_action_kind <> 'read' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    preview_installation_id_value := null;
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = target_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_value ->> 'storageScope')
    or (preview_installation_id_value is null
      and catalogue_row.physical_schema_token not in ('record_data', 'system_projection'))
    or (preview_installation_id_value is not null
      and catalogue_row.physical_schema_token <> 'record_data')
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
    or (preview_installation_id_value is null and not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = target_module_root_id
        and provision.release_revision = target_release_revision
        and release_storage_contract_id = any (provision.storage_contract_ids)
    )) then
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

  select release.record_content into strict application_content
  from vortex_definition.runtime_releases as release
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
    'declaration', case when preview_installation_id_value is not null
      then pg_catalog.jsonb_build_object(
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
        'authority', pg_catalog.jsonb_build_object('kind', 'preview_owner')
      )
      when pg_catalog.jsonb_array_length(required_permissions) = 0 then null
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
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is ambiguous';
end
$function$;
alter function vortex_record.resolve_record_action_context_internal(uuid,text) owner to vortex_record_adapter;


alter function vortex_record.resolve_record_action_context_internal(uuid, text)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_record_action_context_internal(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.resolve_record_action_context_internal(uuid, text) is
  'Private Record metadata resolver over one exact live installation or an owner-validated, unexpired preview storage binding; preview contexts support only reads and base record changes.';

CREATE OR REPLACE FUNCTION vortex_record.load_named_action_facts_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  p_action_kind text := 'named';
  action_context jsonb;
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  installation jsonb;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  module_root_value uuid;
  type_meta jsonb := '{}'::jsonb;
  module_type_meta jsonb;
  storage_disagrees boolean;
  type_columns jsonb;
  target_columns jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; this adapter consumes them and adds none.
  installation := vortex_definition.read_current_active_installation();

  -- Step 3: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Each release is read in a
  -- few set-based statements instead of a PL/pgSQL round trip for every type,
  -- field and permission. Physical tokens are resolved here; a type's column
  -- map and value expression are built only when one of its rows is loaded.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;
    release_content := vortex_record.with_installed_record_contributions_internal(
      release_content, context_organization_id, module_root_value
    );

    -- Every record type must agree with its storage: an active catalogue entry
    -- for this Module and type, provisioned by this release, with an active
    -- column for each declared field.
    select coalesce(pg_catalog.bool_or(
        catalogue.storage_contract_id is null
        or catalogue.state <> 'active'
        or catalogue.module_root_id <> module_root_value
        or catalogue.record_type_id <> (record_type_item.value ->> 'recordTypeId')::uuid
        or catalogue.storage_scope is distinct from (record_type_item.value ->> 'storageScope')
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and catalogue.storage_contract_id = any (provision.storage_contract_ids)
        )
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(record_type_item.value -> 'fields') as field_item(value)
          left join vortex_record.field_storage_mappings as mapping
            on mapping.storage_contract_id = catalogue.storage_contract_id
            and mapping.field_id = (field_item.value ->> 'fieldId')::uuid
          where mapping.storage_contract_id is null or mapping.state <> 'active'
        )
      ), false),
      pg_catalog.jsonb_object_agg(
        pg_catalog.lower(record_type_item.value ->> 'recordTypeId'),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', (record_type_item.value ->> 'recordTypeId')::uuid,
          'storageContractId', (record_type_item.value ->> 'storageContractId')::uuid,
          'storageScope', record_type_item.value ->> 'storageScope',
          'physicalSchemaToken', catalogue.physical_schema_token,
          'ownershipMode', record_type_item.value ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue.physical_table_token,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item.value -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by record_type_item.ordinality
      )
    into storage_disagrees, module_type_meta
    from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes')
      with ordinality as record_type_item(value, ordinality)
    left join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = (record_type_item.value ->> 'storageContractId')::uuid;
    if storage_disagrees then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    type_meta := type_meta || coalesce(module_type_meta, '{}'::jsonb);

    -- Every declared target, single or polymorphic, as one uniform list;
    -- Access proves a concrete edge target a member of it.
    relationship_by_id := relationship_by_id || coalesce((
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(relationship_item.value ->> 'relationshipId'),
        pg_catalog.jsonb_build_object(
          'relationshipId', relationship_item.value -> 'relationshipId',
          'fromModuleRootId', module_root_value,
          'fromRecordTypeId', record_type_item.value -> 'recordTypeId',
          'toRecordTypes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'moduleRootId', target.value -> 'moduleRootId',
              'recordTypeId', target.value -> 'recordTypeId'
            ) order by target.ordinality)
            from pg_catalog.jsonb_array_elements(
              case when relationship_item.value ? 'toRecordType'
                then pg_catalog.jsonb_build_array(relationship_item.value -> 'toRecordType')
                else relationship_item.value -> 'toRecordTypes'
              end
            ) with ordinality as target(value, ordinality)
          ), '[]'::jsonb)
        )
        order by record_type_item.ordinality, relationship_item.ordinality
      )
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes')
        with ordinality as record_type_item(value, ordinality)
      cross join lateral pg_catalog.jsonb_array_elements(record_type_item.value -> 'relationships')
        with ordinality as relationship_item(value, ordinality)
    ), '{}'::jsonb);

    condition_list := condition_list || coalesce((
      select pg_catalog.jsonb_agg(condition_item.value order by condition_item.ordinality)
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) with ordinality as condition_item(value, ordinality)
    ), '[]'::jsonb);

    permission_by_id := permission_by_id || coalesce((
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(permission_item.value ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'module',
          'ownerId', module_root_value,
          'recordTypeId', permission_item.value -> 'recordTypeId',
          'actionKind', permission_item.value -> 'actionKind',
          'namedAction', permission_item.value -> 'namedAction',
          'recordScope', permission_item.value -> 'recordScope'
        )
        order by permission_item.ordinality
      )
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) with ordinality as permission_item(value, ordinality)
      where pg_catalog.jsonb_typeof(permission_item.value -> 'recordScope') = 'object'
    ), '{}'::jsonb);
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = context_application_root_id
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;

  permission_by_id := permission_by_id || coalesce((
    select pg_catalog.jsonb_object_agg(
      pg_catalog.lower(permission_item.value ->> 'permissionId'),
      pg_catalog.jsonb_build_object(
        'ownerKind', 'application',
        'ownerId', context_application_root_id,
        'recordTypeId', permission_item.value -> 'recordTypeId',
        'actionKind', permission_item.value -> 'actionKind',
        'namedAction', permission_item.value -> 'namedAction',
        'recordScope', permission_item.value -> 'recordScope'
      )
      order by permission_item.ordinality
    )
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) with ordinality as permission_item(value, ordinality)
    where pg_catalog.jsonb_typeof(permission_item.value -> 'recordScope') = 'object'
  ), '{}'::jsonb);

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  if target_meta ->> 'physicalSchemaToken' is distinct from 'record_data' then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;
  target_columns := vortex_record.named_action_storage_columns_internal(
    (target_meta ->> 'storageContractId')::uuid, target_meta -> 'fields'
  );
  type_columns := pg_catalog.jsonb_build_object(
    target_meta ->> 'storageContractId', target_columns
  );
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the exact named declaration resolved from the installed owner.
  required_permissions := action_context #> '{declaration,requiredPermissions}';
  declaration := action_context -> 'declaration';

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_columns ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );
  target_fact := record_fact;

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;
      if current_meta ->> 'physicalSchemaToken' is distinct from 'record_data' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if not (type_columns ? (current_meta ->> 'storageContractId')) then
        type_columns := type_columns || pg_catalog.jsonb_build_object(
          current_meta ->> 'storageContractId',
          vortex_record.named_action_storage_columns_internal(
            (current_meta ->> 'storageContractId')::uuid, current_meta -> 'fields'
          )
        );
      end if;

      load_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(
           ''recordScope'', pg_catalog.jsonb_build_object(
             ''storageScope'', %L,
             ''organizationId'', stored.organisation_id,
             ''moduleRootId'', %L::uuid,
             ''recordTypeId'', %L::uuid,
             ''storageContractId'', %L::uuid,
             ''recordId'', stored.record_id
           ) || case when %L = ''application_contained''
             then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
             else ''{}''::jsonb end,
           ''lifecycleState'', stored.lifecycle_state,
           ''fieldValues'', pg_catalog.jsonb_build_object(%s)
         ) || case
           when stored.owner_organisation_account_id is not null
             then pg_catalog.jsonb_build_object(
               ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
           when stored.owner_group_id is not null
             then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope',
        type_columns #>> array[current_meta ->> 'storageContractId', 'valueExpression'],
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'moduleRootId', meta.value -> 'moduleRootId',
          'recordTypeId', meta.value -> 'recordTypeId',
          'storageContractId', meta.value -> 'storageContractId',
          'storageScope', meta.value -> 'storageScope',
          'ownershipMode', meta.value -> 'ownershipMode',
          'validationContractVersion', meta.value -> 'validationContractVersion',
          'fields', meta.value -> 'fields'
        ) || case
          when meta.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by meta.key collate "C"
      )
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'table', target_table,
    'columns', target_columns -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'actionContext', action_context,
    'fieldValues', target_fact -> 'fieldValues'
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) to vortex_record_adapter;

comment on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) is
  'Private static named-action facts loader reusing the complete existing Access record-scope closure without requiring ordinary read or update authority.';

create or replace function vortex_record.relationship_total_catalogue_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  installation jsonb;
  binding jsonb;
  content jsonb;
  record_types jsonb := '[]'::jsonb;
  relationships jsonb := '[]'::jsonb;
  has_before_save_flows boolean := false;
  record_type jsonb;
begin
  installation := vortex_definition.read_current_active_installation();
  for binding in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') item(value)
    order by item.value ->> 'moduleRootId'
  loop
    begin
      select release.compilation_output #> '{canonical,content}' into strict content
      from vortex_definition.runtime_releases release
      where release.root_id = (binding ->> 'moduleRootId')::uuid
        and release.release_revision = (binding ->> 'moduleReleaseRevision')::bigint;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_MODULE_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('root=%s revision=%s cause=%s',
            binding ->> 'moduleRootId', binding ->> 'moduleReleaseRevision', sqlstate);
    end;
    if pg_catalog.jsonb_typeof(content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000', message = 'Installed Record definitions are unavailable';
    end if;
    -- The record types a save closure sees carry the fields other installed Modules contributed
    -- to them; a preview runs its own storage and receives none.
    if not installation ? 'previewInstallationId' then
      content := vortex_record.with_installed_record_contributions_internal(
        content, (installation ->> 'organizationId')::uuid, (binding ->> 'moduleRootId')::uuid
      );
    end if;
    has_before_save_flows := has_before_save_flows or exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(content -> 'flows', '[]'::jsonb)) flow(value)
      cross join pg_catalog.jsonb_array_elements(
        coalesce(flow.value -> 'triggers', '[]'::jsonb)
      ) trigger(value)
      where trigger.value ->> 'type' = 'BeforeSave'
    );
    record_types := record_types || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'moduleReleaseRevision', binding -> 'moduleReleaseRevision'
        )
        order by item.value ->> 'recordTypeId'
      )
      from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    ), '[]'::jsonb);
    for record_type in
      select item.value from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    loop
      relationships := relationships || coalesce(record_type -> 'relationships', '[]'::jsonb);
    end loop;
  end loop;
  return pg_catalog.jsonb_build_object(
    'recordTypes', record_types,
    'relationships', relationships,
    'hasBeforeSaveFlows', has_before_save_flows
  );
end
$function$;

alter function vortex_record.relationship_total_catalogue_internal() owner to vortex_record_adapter;

revoke all on function vortex_record.relationship_total_catalogue_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.relationship_total_catalogue_internal()
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_catalogue_internal() is
  'Private relationship-total catalogue for the validated human Application request context.';

create or replace function vortex_record.read_installed_record_contributions()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  installation jsonb;
  binding_item jsonb;
  module_content jsonb;
  effective_content jsonb;
  record_type_item jsonb;
  effective_type jsonb;
  contributions jsonb;
  result jsonb := '[]'::jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Installed contributions require an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;

  -- A preview runs its own storage and receives no contributions.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '') is not null then
    return result;
  end if;

  -- The exact installed contributions on the record types of the Modules this application's active
  -- installation binds, resolved through the one effective-field builder every record reader and
  -- writer uses, so what the page is told is exactly what the record paths will serve.
  installation := vortex_definition.read_current_active_installation();
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = (binding_item ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_item ->> 'moduleReleaseRevision')::bigint;
    effective_content := vortex_record.with_installed_record_contributions_internal(
      module_content, organization_id_value, (binding_item ->> 'moduleRootId')::uuid
    );
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
      where not item.value ? 'systemProjection'
    loop
      select item.value into effective_type
      from pg_catalog.jsonb_array_elements(effective_content -> 'recordTypes') as item(value)
      where item.value ->> 'recordTypeId' = record_type_item ->> 'recordTypeId';
      select coalesce(pg_catalog.jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
      into contributions
      from pg_catalog.jsonb_array_elements(
        vortex_record.installed_record_type_contributions_internal(
          organization_id_value, (binding_item ->> 'moduleRootId')::uuid,
          (record_type_item ->> 'storageContractId')::uuid
        )
      ) with ordinality as entry(value, ordinality)
      where exists (
        select 1
        from pg_catalog.jsonb_array_elements(effective_type -> 'fields') as field(value)
        where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(entry.value ->> 'contributionId')
      );
      if contributions <> '[]'::jsonb then
        result := result || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'moduleRootId', binding_item -> 'moduleRootId',
            'recordTypeId', record_type_item -> 'recordTypeId',
            'contributions', contributions
          )
        );
      end if;
    end loop;
  end loop;
  return result;
exception
  when no_data_found then
    raise exception using errcode = '55000', message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Installed definition evidence is ambiguous';
end
$function$;

alter function vortex_record.read_installed_record_contributions() owner to vortex_record_adapter;

revoke all on function vortex_record.read_installed_record_contributions()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_installed_record_contributions() to vortex_request;
grant execute on function vortex_record.read_installed_record_contributions() to vortex_owner;

comment on function vortex_record.read_installed_record_contributions() is
  'The fields other installed Modules of the organisation contributed to the record types of the Modules the current application binds, as the record paths serve them: owner Module, owner record type and each contributing Module with its exact field definition. Reads under the validated human request context; a preview receives none.';

reset role;

set local role vortex_owner;

create or replace function vortex_record.installed_record_type_contributions_internal(
  p_organization_id uuid,
  p_target_module_root_id uuid,
  p_target_storage_contract_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_target_module_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or p_target_storage_contract_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_storage_contract_id::text) then
    raise exception using errcode = '22023',
      message = 'Installed contribution selector is invalid';
  end if;

  -- The exact installed field contributions of one owner record type: the active field mappings
  -- that a contributor Module release introduced on the owner's storage (written only by the
  -- exact contribution provisioner after the declaration was resolved against the owner's
  -- extension point), kept only while that contributor Module is bound by an active installation
  -- in this organisation. The mapping carries the contributor's exact field definition. A
  -- contribution neither of those two facts vouches for is never returned. Only optional value
  -- fields are contributed: a link or a produced value needs relationships and calculation
  -- context the owner record does not carry.
  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'kind', 'field',
        'contributionId', mapping.field_id,
        'contributorModuleRootId', mapping.introduced_by_module_root_id,
        'contributorReleaseRevision', pins.release_revision,
        'contributorApplicationRootIds', pins.application_root_ids,
        'field', mapping.field_definition
      ) order by mapping.field_id
    )
    from vortex_record.field_storage_mappings as mapping
    cross join lateral (
      select pg_catalog.max(binding.module_release_revision) as release_revision,
        pg_catalog.jsonb_agg(distinct binding.application_root_id) as application_root_ids
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = p_organization_id
        and binding.module_root_id = mapping.introduced_by_module_root_id
        and binding.state = 'active'
      having pg_catalog.count(*) > 0
    ) as pins
    where mapping.storage_contract_id = p_target_storage_contract_id
      and mapping.state = 'active'
      and mapping.introduced_by_module_root_id <> p_target_module_root_id
      and mapping.field_definition ->> 'type' not in (
        'link', 'link_to_one_of_several', 'calculation', 'total'
      )
      and mapping.field_definition -> 'required' = 'false'::jsonb
  ), '[]'::jsonb);
end
$function$;

alter function vortex_record.installed_record_type_contributions_internal(uuid,uuid,uuid) owner to vortex_owner;

revoke all on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_record_type_contributions_internal(uuid, uuid, uuid) is
  'Private exact installed field contributions of one owner record type in one organisation: the active contributor field mappings on the owner''s storage whose contributor Module is bound by an active installation of that organisation, with the contributor''s exact field definition. Owner-only except for the fixed record adapter; it decides no access.';

create or replace function vortex_record.installed_contribution_pins_internal(
  p_organization_id uuid,
  p_module_root_ids uuid[]
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_module_root_ids is null then
    raise exception using errcode = '22023',
      message = 'Installed contribution selector is invalid';
  end if;

  -- The exact pins of every installed field contribution on the given Modules' storage, in one
  -- canonical string: the contributing Module, its active binding and the contributed field. An
  -- access plan keyed by it can never outlive the contributions it was built from.
  return coalesce((
    select pg_catalog.string_agg(pin.value, ',' order by pin.value collate "C")
    from (
      select distinct mapping.storage_contract_id::text || ':' || mapping.field_id::text || ':'
        || binding.application_root_id::text || ':' || binding.module_release_revision::text
        || ':' || binding.binding_revision::text as value
      from vortex_record.storage_catalogue as catalogue
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = catalogue.storage_contract_id
        and mapping.state = 'active'
        and mapping.introduced_by_module_root_id <> catalogue.module_root_id
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = p_organization_id
        and binding.module_root_id = mapping.introduced_by_module_root_id
        and binding.state = 'active'
      where catalogue.module_root_id = any (p_module_root_ids)
        and catalogue.state = 'active'
    ) as pin
  ), '');
end
$function$;

alter function vortex_record.installed_contribution_pins_internal(uuid,uuid[]) owner to vortex_owner;

revoke all on function vortex_record.installed_contribution_pins_internal(uuid, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_contribution_pins_internal(uuid, uuid[])
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_contribution_pins_internal(uuid, uuid[]) is
  'Private canonical pin string of the installed field contributions on the given Modules'' storage in one organisation; part of the installation access plan key. Owner-only except for the fixed record adapter.';

create or replace function vortex_access.contributed_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision_organization_id uuid;
  checked_at timestamptz := pg_catalog.statement_timestamp();
  contribution jsonb;
  field_id_value text;
  candidate record;
  granted record;
  policy jsonb;
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
begin
  if p_decision is null or p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Contributed field bounds require an allowed record decision';
  end if;
  -- A decision that names no record binding concerns no owner record type, so nothing is
  -- contributed to it.
  if not pg_catalog.pg_input_is_valid(p_decision ->> 'organizationId', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,moduleRootId}', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_decision #>> '{recordBinding,storageContractId}', 'uuid') then
    return '{"readableFieldIds":[],"changeableFieldIds":[]}'::jsonb;
  end if;
  decision_organization_id := (p_decision ->> 'organizationId')::uuid;
  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from decision_organization_id then
    raise exception using errcode = '42501',
      message = 'Contributed field bounds require the decision''s own organisation';
  end if;

  -- The owner record's own decision already admitted this record under the owner's permissions.
  -- A field another installed Module contributed to the record's type is added only where the
  -- person also holds a current permission the contributor declared for that field: its field
  -- policy must list the field, and its record scope must be unconditional, because the
  -- contributor's row scope cannot be evaluated on a record the contributor does not own.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(
      vortex_record.installed_record_type_contributions_internal(
        decision_organization_id,
        (p_decision #>> '{recordBinding,moduleRootId}')::uuid,
        (p_decision #>> '{recordBinding,storageContractId}')::uuid
      )
    ) as item(value)
    where item.value ->> 'kind' = 'field'
  loop
    field_id_value := pg_catalog.lower(contribution ->> 'contributionId');
    for candidate in
      select distinct entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.record_type_id, entry.action_kind
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = decision_organization_id
        and entry.registration_kind = 'application'
        and entry.record_type_id is not null
        and entry.action_kind in ('read', 'update')
        and entry.application_root_id in (
          select pg_catalog.lower(application.value)::uuid
          from pg_catalog.jsonb_array_elements_text(
            contribution -> 'contributorApplicationRootIds'
          ) as application(value)
        )
        and (
          (entry.owner_kind = 'module'
            and entry.owner_id = (contribution ->> 'contributorModuleRootId')::uuid)
          or (entry.owner_kind = 'application'
            and entry.owner_id = entry.application_root_id)
        )
      order by entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id
    loop
      for granted in
        select path.permission_entry, path.path_valid_until
        from vortex_access.evaluate_permission_role_path_internal(
          context_value, checked_at,
          pg_catalog.jsonb_build_object(
            'applicationRootId', candidate.application_root_id,
            'ownerKind', candidate.owner_kind,
            'ownerId', candidate.owner_id,
            'permissionId', candidate.permission_id
          ),
          pg_catalog.jsonb_build_object('actionKind', candidate.action_kind),
          candidate.record_type_id
        ) as path
      loop
        if granted.path_valid_until is null
          or granted.path_valid_until <= checked_at
          or pg_catalog.jsonb_typeof((granted.permission_entry).record_scope) is distinct from 'object'
          or (granted.permission_entry).record_scope ? 'savedCondition'
          or not coalesce(
            (granted.permission_entry).record_scope -> 'routes' @> '[{"kind":"all_records"}]'::jsonb,
            false
          ) then
          continue;
        end if;
        policy := (granted.permission_entry).field_policy;
        if pg_catalog.jsonb_typeof(policy) is distinct from 'object' then
          continue;
        end if;
        if exists (
          select 1 from pg_catalog.jsonb_array_elements_text(policy -> 'readableFieldIds') as item(value)
          where pg_catalog.lower(item.value) = field_id_value
        ) then
          readable_ids := readable_ids || field_id_value;
          if candidate.action_kind = 'update' and exists (
            select 1 from pg_catalog.jsonb_array_elements_text(policy -> 'changeableFieldIds') as item(value)
            where pg_catalog.lower(item.value) = field_id_value
          ) then
            changeable_ids := changeable_ids || field_id_value;
          end if;
        end if;
      end loop;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(array(
      select distinct field.value from pg_catalog.unnest(readable_ids) as field(value) order by field.value
    )),
    'changeableFieldIds', pg_catalog.to_jsonb(array(
      select distinct field.value from pg_catalog.unnest(changeable_ids) as field(value) order by field.value
    ))
  );
end
$function$;

alter function vortex_access.contributed_field_bounds_internal(jsonb) owner to vortex_owner;

revoke all on function vortex_access.contributed_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.contributed_field_bounds_internal(jsonb)
  to vortex_owner;

comment on function vortex_access.contributed_field_bounds_internal(jsonb) is
  'Private contributed-field bounds over one allowed exact-record decision: the fields other installed Modules contributed to the record''s type that the person may read and change through a current permission the contributor declared for them. It adds only to a decision the owner''s permissions already allowed and never decides record access.';

create or replace function vortex_access.resolve_record_field_bounds_internal(
  p_decision jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  decision_organization_id uuid := (p_decision ->> 'organizationId')::uuid;
  contribution jsonb;
  contribution_permission jsonb;
  contribution_source jsonb;
  contribution_route jsonb;
  catalogue_entry vortex_access.permission_catalogue_entries%rowtype;
  policy_readable text[];
  policy_changeable text[];
  readable_ids text[] := array[]::text[];
  changeable_ids text[] := array[]::text[];
  contributed_bounds jsonb;
begin
  if p_decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '22023',
      message = 'Record field bounds require an allowed decision';
  end if;

  for contribution in
    select value
    from pg_catalog.jsonb_array_elements(p_decision -> 'matchedContributions') as item(value)
  loop
    contribution_permission := contribution -> 'permission';
    contribution_source := contribution -> 'source';
    contribution_route := contribution -> 'route';

    -- The catalogue entry of the registration revision this contribution's
    -- decision names: the meaning the caller's role accepted, which may be
    -- older than the registered one. Its registration must still be active.
    select entry.*
    into catalogue_entry
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and entry.registration_revision <= registration.revision
      and registration.state = 'active'
    where entry.organization_id = decision_organization_id
      and entry.registration_revision = (contribution ->> 'registrationRevision')::bigint
      and entry.application_root_id = (contribution_permission ->> 'applicationRootId')::uuid
      and entry.owner_kind = contribution_permission ->> 'ownerKind'
      and entry.owner_id = (contribution_permission ->> 'ownerId')::uuid
      and entry.permission_id = (contribution_permission ->> 'permissionId')::uuid;

    -- The decision just used this exact permission; a missing catalogue
    -- entry now is an internal inconsistency, not an ordinary refusal.
    if not found then
      raise exception using errcode = '22023',
        message = 'Record field bounds found no catalogue entry';
    end if;

    -- The source release identity must still match the contribution before
    -- its field policy can be used.
    if catalogue_entry.registration_revision is distinct from
        (contribution ->> 'registrationRevision')::bigint
      or catalogue_entry.source_kind is distinct from (contribution_source ->> 'kind')
      or catalogue_entry.source_definition_key is distinct from (contribution_source ->> 'definitionKey')
      or catalogue_entry.source_root_id is distinct from (contribution_source ->> 'rootId')::uuid
      or catalogue_entry.source_version is distinct from (contribution_source ->> 'releaseVersion')
      or catalogue_entry.source_revision is distinct from (contribution_source ->> 'releaseRevision')::bigint
      or catalogue_entry.source_validation_contract_version
        is distinct from (contribution_source ->> 'validationContractVersion') then
      raise exception using errcode = '22023',
        message = 'Record field bounds found a superseded permission source';
    end if;

    -- No declared field policy means this contribution contributes no
    -- fields; it must not veto a different contribution that has one.
    if catalogue_entry.field_policy is null then
      continue;
    end if;

    -- A direct_share route can only narrow the permission's own policy, so
    -- readable/changeable fields are kept only when the route also names
    -- them; every other route kind contributes the policy as declared.
    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_readable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'readableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'readableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    select pg_catalog.array_agg(pg_catalog.lower(field.value))
    into policy_changeable
    from pg_catalog.jsonb_array_elements_text(
      catalogue_entry.field_policy -> 'changeableFieldIds'
    ) as field(value)
    where contribution_route ->> 'kind' is distinct from 'direct_share'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          contribution_route -> 'changeableFieldIds'
        ) as shared(value)
        where pg_catalog.lower(shared.value) = pg_catalog.lower(field.value)
      );

    readable_ids := readable_ids || coalesce(policy_readable, array[]::text[]);
    changeable_ids := changeable_ids || coalesce(policy_changeable, array[]::text[]);
  end loop;

  -- The fields other installed Modules contributed to this record's type, where the person
  -- also holds the contributor's own permission for them. They only extend what the owner's
  -- permissions already allowed for this record.
  contributed_bounds := vortex_access.contributed_field_bounds_internal(p_decision);
  readable_ids := readable_ids || array(
    select item.value from pg_catalog.jsonb_array_elements_text(
      contributed_bounds -> 'readableFieldIds'
    ) as item(value)
  );
  changeable_ids := changeable_ids || array(
    select item.value from pg_catalog.jsonb_array_elements_text(
      contributed_bounds -> 'changeableFieldIds'
    ) as item(value)
  );

  readable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(readable_ids) as field(value)
    order by field.value
  );
  -- Changeable never exceeds readable, because every contribution's own
  -- changeable set already sits inside its own readable set: the policy
  -- validator enforces that for a permission, and the direct-share table
  -- enforces it for a share. Unioning subsets preserves it, so this only
  -- canonicalises.
  changeable_ids := array(
    select distinct field.value
    from pg_catalog.unnest(changeable_ids) as field(value)
    order by field.value
  );

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.to_jsonb(readable_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(changeable_ids)
  );
end
$function$;
alter function vortex_access.resolve_record_field_bounds_internal(jsonb) owner to vortex_owner;


revoke execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.resolve_record_field_bounds_internal(jsonb)
  to vortex_record_adapter, postgres;

comment on function vortex_access.resolve_record_field_bounds_internal(jsonb) is
  'Private field-bounds resolution over one allowed exact-record access decision; looks each contribution''s field policy up from the permission catalogue itself at the registration revision the decision accepted, never from a caller-supplied declaration.';

alter function vortex_access.resolve_record_field_bounds_internal(jsonb)
  owner to vortex_owner;

reset role;
