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
  if organization_id_value = none_uuid
    or application_root_id_value = none_uuid
    or application_release_revision_value not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      organization_id_value::text || '|' || application_root_id_value::text || '|'
        || application_release_revision_value::text || '|' || coalesce((
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
  cacheable := not exists (
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
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;

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
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and storage_contract_value = any (provision.storage_contract_ids)
        ) then
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
                    'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
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
  from vortex_definition.releases as release
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
  );

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

revoke all on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.resolve_installation_access_plan_internal(jsonb) is
  'Private installation access plan builder and cache: resolves definitions, column maps, permission alternatives and saved conditions once per all-active installation binding revision; a detached pin set is resolved afresh.';
