-- Studio's canvas and Data tab read draft records through the builder's preview installation,
-- and the preview follows the draft in place (#2787).
-- A preview records the fingerprint of the draft data shape it runs. A presentation-only edit
-- leaves that shape as it is, so Studio reads the current preview at once; its pages follow when it
-- is opened. Any other edit moves the preview to the new draft revision in the background, in its own
-- request, with refresh_preview_installation:
-- new releases, pins and registration, and Record storage evolved in place
-- (evolve_preview_module_storage), so the records it holds, those made in the preview included,
-- stay. Only a change the stored records cannot take (V3201) provisions a new preview.
-- create_preview_installation and refresh_preview_installation share one release check
-- (assert_preview_releases_internal) and one writer of pins, storage and registration
-- (write_preview_shape_internal); preview storage for one record type has one writer
-- (provision_preview_record_storage_internal).
-- Reads never wait for the move: they run on the preview as it is until the move commits.
-- read_preview_runtime_source leaves the release set out when the caller already holds the one
-- for the revision the preview runs.
-- read_builder_preview_installation reads the builder's current runnable preview of one
-- Application.
set local role vortex_owner;

alter table vortex_definition.preview_installations
  add column draft_shape_fingerprint text
    check (draft_shape_fingerprint ~ '^sha256:[a-f0-9]{64}$');

drop function vortex_definition.create_preview_installation(uuid, bigint, jsonb);
drop function vortex_definition.read_preview_runtime_source();

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

  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      organization_id_value::text || '|' || application_root_id_value::text || '|'
        || application_release_revision_value::text || '|'
        || case when preview_installation_id_value is null then ''
          else preview_installation_id_value::text || '|' end || coalesce((
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

create or replace function vortex_record.resolve_preview_seed_source_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  source_catalogue vortex_record.storage_catalogue%rowtype;
  live_type jsonb;
  live_plan jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text) then
    raise exception using errcode = '42501', message = 'Preview seed source is invalid';
  end if;
  -- Preview storage is private to its builder, even when its UUID is known and its
  -- organisation, Application, Module and record type match the installed ones.
  if exists (
    select 1 from vortex_record.preview_storage_bindings as binding
    where binding.storage_contract_id = p_storage_contract_id
  ) then
    raise exception using errcode = '42501', message = 'Preview seed source is refused';
  end if;
  select catalogue.* into source_catalogue
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if found and (source_catalogue.module_root_id is distinct from p_module_root_id
    or source_catalogue.record_type_id is distinct from p_record_type_id
    or source_catalogue.physical_schema_token is distinct from 'record_data'
    or source_catalogue.state is distinct from 'active') then
    raise exception using errcode = '42501', message = 'Preview seed source is refused';
  end if;

  -- A new Application or record type has no live records to seed. For an installed
  -- type, resolve the same live plan as record authorization, never the rehearsal.
  if not exists (
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state = 'active'
  ) then
    return null;
  end if;
  live_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_active_installation_for_scope_internal(
      p_organization_id, p_application_root_id
    )
  );
  live_type := live_plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if live_type is null then
    return null;
  end if;
  if (live_type ->> 'moduleRootId')::uuid is distinct from p_module_root_id
    or (live_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id
    or (live_type ->> 'isSystemProjection')::boolean is distinct from false then
    raise exception using errcode = '42501', message = 'Preview seed source disagrees with the live installation';
  end if;
  return live_type;
end
$function$;

alter function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid)
  owner to vortex_owner;
revoke all on function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid) is
  'Validates a preview release storage identity against the installed live record type, refuses every preview storage source, and returns the live access-plan type or null for an uninstalled type.';

create or replace function vortex_record.preview_module_record_types_internal(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Preview storage selector is invalid';
  end if;
  -- The preview's own rehearsed release of an owned Module, or else the stored release.
  select (pg_catalog.jsonb_populate_record(
    null::vortex_definition.releases, preview_release.release
  )).* into release_row
  from vortex_definition.preview_releases as preview_release
  join vortex_definition.roots as root on root.root_id = preview_release.root_id
  where preview_release.preview_installation_id = p_preview_installation_id
    and preview_release.root_id = p_module_root_id
    and preview_release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if not found then
    select release.* into strict release_row
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = p_module_root_id
      and release.release_revision = p_module_release_revision
      and root.kind = 'module';
  end if;
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
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
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
  return record_types;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Exact Module release is ambiguous';
end
$function$;

alter function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint) owner to vortex_owner;

revoke all on function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint) is
  'The validated record types of one exact Module release a preview runs: its rehearsed release of an owned Module, or else the stored release.';

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
  preview_scope record;
  live_type jsonb;
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

  select preview.organization_id, preview.application_root_id into strict preview_scope
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id;
  live_type := vortex_record.resolve_preview_seed_source_internal(
    preview_scope.organization_id, preview_scope.application_root_id,
    p_module_root_id, record_type_id_value, storage_id
  );
  live_table_token := live_type ->> 'table';
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
  record_type jsonb;
  storage_identities jsonb := '[]'::jsonb;
begin
  -- A system projection is the platform's own read model, which a preview reads as it is: it
  -- has no storage of its own to isolate.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
      p_preview_installation_id, p_module_root_id, p_module_release_revision
    )) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      vortex_record.provision_preview_record_storage_internal(
        p_preview_installation_id, p_module_root_id, p_module_release_revision, record_type
      )
    );
  end loop;
  return storage_identities;
end
$function$;

alter function vortex_record.provision_preview_module_storage(uuid,uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint) is
  'Creates empty isolated Record storage for every record type of one exact Module release of a preview, its rehearsed release or a stored one, without provisioning its live release identities.';

create or replace function vortex_record.evolve_preview_module_storage(
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
  record_type jsonb;
  field_value jsonb;
  binding_row vortex_record.preview_storage_bindings%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  release_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  column_token text;
  database_type text;
  index_token text;
  scope_index_columns text;
  evolved_definition jsonb;
  field_ids uuid[];
  storage_identities jsonb := '[]'::jsonb;
begin
  -- The preview follows its draft in place: each record type keeps its storage and its records,
  -- and only what the new release adds or changes is applied to it. A change its records cannot
  -- take raises V3201, and the caller provisions a new preview instead.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
      p_preview_installation_id, p_module_root_id, p_module_release_revision
    )) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    begin
      release_storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    select binding.* into binding_row
    from vortex_record.preview_storage_bindings as binding
    where binding.preview_installation_id = p_preview_installation_id
      and binding.module_root_id = p_module_root_id
      and binding.record_type_id = record_type_id_value
    for update;
    -- A record type the preview did not have yet starts with empty storage.
    if not found then
      storage_identities := storage_identities || pg_catalog.jsonb_build_array(
        vortex_record.provision_preview_record_storage_internal(
          p_preview_installation_id, p_module_root_id, p_module_release_revision, record_type
        )
      );
      continue;
    end if;
    select catalogue.* into strict catalogue_row
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = binding_row.storage_contract_id
      and catalogue.physical_schema_token = 'record_data'
      and catalogue.state = 'active'
    for update;
    if catalogue_row.record_type_definition ->> 'storageScope' is distinct from record_type ->> 'storageScope'
      or catalogue_row.record_type_definition ->> 'ownershipMode' is distinct from record_type ->> 'ownershipMode'
      or pg_catalog.jsonb_typeof(record_type -> 'fields') is distinct from 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') is distinct from 'array' then
      raise exception using errcode = 'V3201', message = 'Preview record storage cannot follow this change';
    end if;
    evolved_definition := pg_catalog.jsonb_set(
      record_type, '{storageContractId}',
      pg_catalog.to_jsonb(binding_row.storage_contract_id::text), true
    );
    -- An unchanged record type keeps its storage exactly as it is: only the release it serves moves.
    if catalogue_row.record_type_definition = evolved_definition then
      if binding_row.module_release_revision <> p_module_release_revision
        or binding_row.release_storage_contract_id is distinct from release_storage_id then
        update vortex_record.storage_catalogue as catalogue
        set first_compatible_release_revision = p_module_release_revision,
            last_compatible_release_revision = p_module_release_revision,
            changed_at = pg_catalog.statement_timestamp()
        where catalogue.storage_contract_id = binding_row.storage_contract_id;
        update vortex_record.field_storage_mappings as mapping
        set introduced_by_module_root_id = p_module_root_id,
            introduced_at_release_revision = p_module_release_revision
        where mapping.storage_contract_id = binding_row.storage_contract_id
          and mapping.state = 'active';
        update vortex_record.preview_storage_bindings as binding
        set module_release_revision = p_module_release_revision,
            release_storage_contract_id = release_storage_id
        where binding.preview_installation_id = p_preview_installation_id
          and binding.storage_contract_id = binding_row.storage_contract_id;
      end if;
      storage_identities := storage_identities || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', p_module_root_id,
          'moduleReleaseRevision', p_module_release_revision,
          'recordTypeId', record_type_id_value,
          'releaseStorageContractId', release_storage_id,
          'previewStorageContractId', binding_row.storage_contract_id
        )
      );
      continue;
    end if;
    scope_index_columns := case catalogue_row.storage_scope
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;
    field_ids := array[]::uuid[];

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
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      field_ids := field_ids || field_id_value;
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        -- Stored values keep their meaning only while the field keeps its database type.
        if mapping_row.database_value_type is distinct from database_type then
          raise exception using errcode = 'V3201', message = 'Preview record storage cannot follow this change';
        end if;
        column_token := mapping_row.physical_column_token;
        -- Preview storage serves exactly the one Module release the preview runs, so each mapping
        -- is that release's.
        update vortex_record.field_storage_mappings as mapping
        set field_definition = field_value,
            introduced_by_module_root_id = p_module_root_id,
            introduced_at_release_revision = p_module_release_revision,
            state = 'active',
            retired_by_module_root_id = null,
            retired_at_release_revision = null
        where mapping.storage_contract_id = binding_row.storage_contract_id
          and mapping.field_id = field_id_value;
      else
        -- Records already in the preview have no value for a new field, so the column takes none;
        -- the save path enforces a required field for every record it writes.
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s',
          catalogue_row.physical_table_token, column_token, vortex_record.sql_value_type(database_type)
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          binding_row.storage_contract_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
      end if;
      -- Table changes run only where the column or its index actually differs.
      if not (field_value ->> 'required')::boolean and exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('record_data.%I', catalogue_row.physical_table_token))
          and attribute.attname = column_token
          and attribute.attnotnull
      ) then
        execute pg_catalog.format(
          'alter table record_data.%I alter column %I drop not null',
          catalogue_row.physical_table_token, column_token
        );
      end if;
      index_token := 'pux_' || pg_catalog.md5(
        binding_row.storage_contract_id::text || ':' || field_id_value::text
      );
      if (field_value ->> 'unique')::boolean
        and pg_catalog.to_regclass(pg_catalog.format('record_data.%I', index_token)) is null then
        begin
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            index_token, catalogue_row.physical_table_token, scope_index_columns, column_token
          );
        exception when unique_violation then
          raise exception using errcode = 'V3201', message = 'Preview records repeat a value the draft makes unique';
        end;
      elsif not (field_value ->> 'unique')::boolean
        and pg_catalog.to_regclass(pg_catalog.format('record_data.%I', index_token)) is not null then
        execute pg_catalog.format('drop index record_data.%I', index_token);
      end if;
    end loop;

    -- A field the draft no longer has keeps its column, retired and empty-able, so the records
    -- keep everything else.
    for mapping_row in
      select mapping.*
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.state = 'active'
        and not (mapping.field_id = any(field_ids))
      order by mapping.field_id
      for update
    loop
      execute pg_catalog.format(
        'alter table record_data.%I alter column %I drop not null',
        catalogue_row.physical_table_token, mapping_row.physical_column_token
      );
      execute pg_catalog.format('drop index if exists record_data.%I', 'pux_' || pg_catalog.md5(
        binding_row.storage_contract_id::text || ':' || mapping_row.field_id::text
      ));
      update vortex_record.field_storage_mappings as mapping
      set state = 'retired',
          retired_by_module_root_id = p_module_root_id,
          retired_at_release_revision = p_module_release_revision
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.field_id = mapping_row.field_id;
    end loop;

    update vortex_record.storage_catalogue as catalogue
    set record_type_definition = evolved_definition,
        content_fingerprint = vortex_record.storage_meaning_fingerprint(evolved_definition),
        -- Preview storage serves exactly the one Module release the preview runs.
        first_compatible_release_revision = p_module_release_revision,
        last_compatible_release_revision = p_module_release_revision,
        changed_at = pg_catalog.statement_timestamp()
    where catalogue.storage_contract_id = binding_row.storage_contract_id;
    update vortex_record.preview_storage_bindings as binding
    set module_release_revision = p_module_release_revision,
        release_storage_contract_id = release_storage_id
    where binding.preview_installation_id = p_preview_installation_id
      and binding.storage_contract_id = binding_row.storage_contract_id;
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id,
        'moduleReleaseRevision', p_module_release_revision,
        'recordTypeId', record_type_id_value,
        'releaseStorageContractId', release_storage_id,
        'previewStorageContractId', binding_row.storage_contract_id
      )
    );
  end loop;
  return storage_identities;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record storage is unavailable';
end
$function$;

alter function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint) owner to vortex_owner;

revoke all on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint) is
  'Moves a preview''s isolated Record storage to a newer exact Module release in place, keeping its records: new record types get empty storage, new fields new empty columns, changed fields their new definition and uniqueness, and removed fields are retired. A change the stored records cannot take (another database type, storage scope or ownership, or a uniqueness they break) raises V3201.';

create or replace function vortex_definition.assert_preview_releases_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_releases jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  rehearsed_type record;
  current_release_revision_value bigint;
  application_release_revision_value bigint;
begin
  if pg_catalog.jsonb_typeof(p_releases) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_releases) > 201
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_releases) as item(value)
      where pg_catalog.jsonb_typeof(item.value -> 'release') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'dependencies') is distinct from 'array'
        or not coalesce(pg_catalog.pg_input_is_valid(item.value #>> '{release,root_id}', 'uuid'), false)
        or not coalesce(pg_catalog.pg_input_is_valid(
          item.value #>> '{release,release_revision}', 'bigint'
        ), false)
    ) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  select root.current_release_revision into current_release_revision_value
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = p_organization_id
    and root.kind = 'application';

  -- Each rehearsed release is the release a publication of this draft writes: the Application
  -- at its draft revision, or an owned Module at its staged draft revision, newer than the
  -- current release of its root and of that root's kind; at most one per root.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where not exists (
      select 1
      from vortex_definition.roots as root
      join vortex_definition.drafts as draft on draft.root_id = root.root_id
      where root.root_id = (item.value #>> '{release,root_id}')::uuid
        and root.organization_id = p_organization_id
        and (root.root_id = p_application_root_id
          or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id))
        and draft.draft_revision = (item.value #>> '{release,release_revision}')::bigint
        and draft.draft_revision > coalesce(root.current_release_revision, 0)
        and item.value #>> '{release,compilation_output,kind}' = root.kind
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
          where dependency.value ->> 'root_id' is distinct from root.root_id::text
            or dependency.value ->> 'release_revision' is distinct from draft.draft_revision::text
        )
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value #>> '{release,root_id}')
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'Rehearsed preview releases are not this Application draft';
  end if;
  -- A rehearsal may describe a new type, but cannot nominate another live or preview
  -- table for a type already installed in this Application. Check before replacing a preview.
  for rehearsed_type in
    select (item.value #>> '{release,root_id}')::uuid as module_root_id, record_type.value
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      item.value #> '{release,compilation_output,canonical,content,recordTypes}'
    ) as record_type(value)
    where item.value #>> '{release,compilation_output,kind}' = 'module'
      and not record_type.value ? 'systemProjection'
  loop
    perform vortex_record.resolve_preview_seed_source_internal(
      p_organization_id, p_application_root_id, rehearsed_type.module_root_id,
      (rehearsed_type.value ->> 'recordTypeId')::uuid,
      (rehearsed_type.value ->> 'storageContractId')::uuid
    );
  end loop;
  application_release_revision_value := coalesce((
    select (item.value #>> '{release,release_revision}')::bigint
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where (item.value #>> '{release,root_id}')::uuid = p_application_root_id
  ), current_release_revision_value);
  if application_release_revision_value is null then
    raise exception using errcode = 'P0002', message = 'Application has no release to preview';
  end if;
  return application_release_revision_value;
end
$function$;

alter function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb)
  to vortex_owner;
comment on function vortex_definition.assert_preview_releases_internal(uuid, uuid, jsonb) is
  'Checks that rehearsed releases are exactly what a publication of the Application draft writes, and returns the Application release revision the preview runs: the rehearsed one, or the current release when the draft changes no Application content.';

create or replace function vortex_definition.write_preview_shape_internal(
  p_preview_installation_id uuid,
  p_evolve boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row vortex_definition.preview_installations%rowtype;
  module_pin record;
  owned_release record;
  application_content_value jsonb;
  system_projection_ids_value uuid[] := array[]::uuid[];
  resolved_modules_value jsonb := '[]'::jsonb;
  storage_identities_value jsonb := '[]'::jsonb;
begin
  select preview.* into strict preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
  for no key update;

  -- The exact Module pins of the previewed Application release, through every Module dependency,
  -- each read from this preview's rehearsed releases first and the stored releases otherwise.
  for module_pin in
    with recursive edges as (
      select dependency.root_id, dependency.release_revision,
        dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.dependency_kind = 'module'
        and not exists (
          select 1 from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = p_preview_installation_id
            and preview.root_id = dependency.root_id
            and preview.release_revision = dependency.release_revision
        )
      union all
      select preview.root_id, preview.release_revision,
        (dependency.value ->> 'target_root_id')::uuid,
        (dependency.value ->> 'target_release_revision')::bigint
      from vortex_definition.preview_releases as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.dependencies) as dependency(value)
      where preview.preview_installation_id = p_preview_installation_id
        and dependency.value ->> 'dependency_kind' = 'module'
    ), closure(module_root_id, module_release_revision) as (
      select edge.target_root_id, edge.target_release_revision
      from edges as edge
      where edge.root_id = preview_row.application_root_id
        and edge.release_revision = preview_row.application_release_revision
      union
      select edge.target_root_id, edge.target_release_revision
      from closure
      join edges as edge
        on edge.root_id = closure.module_root_id
        and edge.release_revision = closure.module_release_revision
    )
    select closure.module_root_id, closure.module_release_revision,
      coalesce(
        (select preview.release ->> 'release_version'
          from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = p_preview_installation_id
            and preview.root_id = closure.module_root_id
            and preview.release_revision = closure.module_release_revision),
        (select release.release_version
          from vortex_definition.releases as release
          join vortex_definition.roots as root on root.root_id = release.root_id
          where release.root_id = closure.module_root_id
            and release.release_revision = closure.module_release_revision
            and root.kind = 'module'
            and root.organization_id = preview_row.organization_id)
      ) as release_version
    from closure
    order by closure.module_root_id, closure.module_release_revision
  loop
    if module_pin.module_root_id is null
      or module_pin.module_release_revision not between 1 and 9007199254740991
      or module_pin.release_version is null
      or resolved_modules_value @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('moduleRootId', module_pin.module_root_id)
      ) then
      raise exception using errcode = '23514',
        message = 'Preview Module pins are unavailable or ambiguous';
    end if;
    resolved_modules_value := resolved_modules_value || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_pin.module_root_id,
        'moduleReleaseRevision', module_pin.module_release_revision,
        'releaseVersion', module_pin.release_version
      )
    );
    storage_identities_value := storage_identities_value || case when p_evolve
      then vortex_record.evolve_preview_module_storage(
        p_preview_installation_id, module_pin.module_root_id, module_pin.module_release_revision
      )
      else vortex_record.provision_preview_module_storage(
        p_preview_installation_id, module_pin.module_root_id, module_pin.module_release_revision
      )
    end;
  end loop;
  if pg_catalog.jsonb_array_length(resolved_modules_value) = 0 then
    raise exception using errcode = '23514', message = 'Previewed Application binds no Module';
  end if;

  -- The preview's own permission registration: what the previewed Application and its own
  -- Modules declare, at the releases the preview runs, and the draft's roles, which only the
  -- builder who opened the preview holds. A used Module's permissions are not part of it.
  insert into vortex_access.preview_permission_registrations (
    preview_installation_id, organization_id, application_root_id, organization_account_id,
    system_projection_record_type_ids, owned_owner_ids, role_ids
  )
  select p_preview_installation_id, preview_row.organization_id, preview_row.application_root_id,
    preview_row.previewer_organization_account_id,
    array[]::uuid[],
    pg_catalog.array_append(
      coalesce(pg_catalog.array_agg(owned.module_root_id order by owned.module_root_id), array[]::uuid[]),
      preview_row.application_root_id
    ),
    array[]::uuid[]
  from (
    select (pin.value ->> 'moduleRootId')::uuid as module_root_id
    from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    join vortex_definition.roots as root
      on root.root_id = (pin.value ->> 'moduleRootId')::uuid
    where root.organization_id = preview_row.organization_id
      and root.kind = 'module'
      and root.owner_application_root_id = preview_row.application_root_id
  ) as owned;

  for owned_release in
    select pinned.root_id, root.key, pinned.owner_kind,
      coalesce(preview.release, pg_catalog.to_jsonb(stored.*)) as release
    from (
      select preview_row.application_root_id as root_id,
        preview_row.application_release_revision as release_revision,
        'application'::text as owner_kind
      union all
      select (pin.value ->> 'moduleRootId')::uuid, (pin.value ->> 'moduleReleaseRevision')::bigint,
        'module'
      from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    ) as pinned
    join vortex_definition.roots as root
      on root.root_id = pinned.root_id
      and root.organization_id = preview_row.organization_id
      and root.kind = pinned.owner_kind
      and (root.root_id = preview_row.application_root_id
        or root.owner_application_root_id = preview_row.application_root_id)
    left join vortex_definition.preview_releases as preview
      on preview.preview_installation_id = p_preview_installation_id
      and preview.root_id = pinned.root_id
      and preview.release_revision = pinned.release_revision
    left join vortex_definition.releases as stored
      on preview.root_id is null
      and stored.root_id = pinned.root_id
      and stored.release_revision = pinned.release_revision
    order by pinned.owner_kind, pinned.root_id
  loop
    if owned_release.release is null
      or pg_catalog.jsonb_typeof(
        owned_release.release #> '{compilation_output,canonical,content,permissions}'
      ) is distinct from 'array' then
      raise exception using errcode = '23514',
        message = 'Previewed permission declarations are unavailable';
    end if;
    if owned_release.owner_kind = 'application' then
      application_content_value := owned_release.release #> '{compilation_output,canonical,content}';
    end if;
    insert into vortex_access.preview_permission_entries (
      preview_installation_id, entry, held
    )
    select p_preview_installation_id,
      pg_catalog.jsonb_populate_record(
        null::vortex_access.permission_catalogue_entries,
        pg_catalog.jsonb_build_object(
          'organization_id', preview_row.organization_id,
          'registration_kind', 'application',
          'registration_owner_id', preview_row.application_root_id,
          'registration_revision', 1,
          'application_root_id', preview_row.application_root_id,
          'owner_kind', owned_release.owner_kind,
          'owner_id', owned_release.root_id,
          'permission_id', permission.value ->> 'permissionId',
          'permission_key', permission.value ->> 'key',
          'label', permission.value ->> 'label',
          'description', permission.value ->> 'description',
          'record_type_id', permission.value ->> 'recordTypeId',
          'action_kind', permission.value ->> 'actionKind',
          'named_action', permission.value ->> 'namedAction',
          'administrative', permission.value -> 'administrative',
          'source_kind', owned_release.owner_kind,
          'source_definition_key', owned_release.key,
          'source_root_id', owned_release.root_id,
          'source_version', owned_release.release ->> 'release_version',
          'source_revision', owned_release.release -> 'release_revision',
          'source_validation_contract_version',
            owned_release.release ->> 'validation_contract_version',
          'meaning_fingerprint', owned_release.release ->> 'content_fingerprint',
          'record_scope', permission.value -> 'recordScope',
          'field_policy', permission.value -> 'fieldPolicy'
        )
      ),
      false
    from pg_catalog.jsonb_array_elements(
      owned_release.release #> '{compilation_output,canonical,content,permissions}'
    ) as permission(value);
  end loop;
  if application_content_value is null
    or pg_catalog.jsonb_typeof(application_content_value -> 'roles') is distinct from 'array' then
    raise exception using errcode = '23514',
      message = 'Previewed permission declarations are unavailable';
  end if;

  -- A system projection, of an own Module or a used one, is the platform's live read model: every
  -- permission on it is decided by the builder's own live access, never by a preview role.
  select coalesce(pg_catalog.array_agg(distinct (record_type.value ->> 'recordTypeId')::uuid), array[]::uuid[])
  into system_projection_ids_value
  from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
  left join vortex_definition.preview_releases as preview
    on preview.preview_installation_id = p_preview_installation_id
    and preview.root_id = (pin.value ->> 'moduleRootId')::uuid
    and preview.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  left join vortex_definition.releases as stored
    on preview.root_id is null
    and stored.root_id = (pin.value ->> 'moduleRootId')::uuid
    and stored.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(
      coalesce(preview.release -> 'compilation_output', stored.compilation_output)
        #> '{canonical,content,recordTypes}',
      '[]'::jsonb
    )
  ) as record_type(value)
  where record_type.value ? 'systemProjection';
  update vortex_access.preview_permission_registrations as registration
  set system_projection_record_type_ids = system_projection_ids_value
  where registration.preview_installation_id = p_preview_installation_id;

  -- The builder holds every role of the draft: a permission is held when a role selects it, an
  -- Application-wide selection taking only the Application's ordinary permissions, as it does
  -- at installation. A permission on a system projection is never held in a preview.
  update vortex_access.preview_permission_entries as preview_entry
  set held = true
  where preview_entry.preview_installation_id = p_preview_installation_id
    and not coalesce((preview_entry.entry).record_type_id = any(system_projection_ids_value), false)
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
      where role.value -> 'permissionKeys' ? (preview_entry.entry).permission_key
        and (
          role.value #>> '{permissionSelection,kind}' = 'exact'
          or (
            role.value #>> '{permissionSelection,kind}' = 'application_wildcard'
            and (preview_entry.entry).owner_kind = 'application'
            and not (preview_entry.entry).administrative
            and (preview_entry.entry).action_kind <> 'export'
          )
        )
    );
  update vortex_access.preview_permission_registrations as registration
  set role_ids = coalesce((
    select pg_catalog.array_agg(distinct (role.value ->> 'roleId')::uuid)
    from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
  ), array[]::uuid[])
  where registration.preview_installation_id = p_preview_installation_id;

  update vortex_definition.preview_installations as preview
  set resolved_modules = resolved_modules_value,
      storage_identities = storage_identities_value
  where preview.preview_installation_id = p_preview_installation_id;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview installation is unavailable';
end
$function$;

alter function vortex_definition.write_preview_shape_internal(uuid, boolean) owner to vortex_owner;

revoke all on function vortex_definition.write_preview_shape_internal(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.write_preview_shape_internal(uuid, boolean)
  to vortex_owner;
comment on function vortex_definition.write_preview_shape_internal(uuid, boolean) is
  'Writes what a preview runs from its rehearsed releases: the exact Module pins, its isolated Record storage (new, or moved in place to the new releases keeping its records), and its own permission registration with the draft''s roles, which only its builder holds.';

create or replace function vortex_definition.create_preview_installation(
  p_application_root_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb,
  p_shape_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  organization_id_value uuid;
  organization_account_id_value uuid;
  identity_id_value uuid;
  preview_installation_id_value uuid;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  previous_preview record;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  -- A preview is provisioned in the organisation's context: the Application it previews may have
  -- no installation, and so no Application context, yet.
  if checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  select draft.draft_revision
  into draft_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
  for share of draft;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    organization_id_value, p_application_root_id, p_releases
  );

  -- One preview per Application and builder: a new preview replaces this builder's previous one
  -- and its storage, never another builder's.
  for previous_preview in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = organization_id_value
      and preview.application_root_id = p_application_root_id
      and preview.previewer_organization_account_id = organization_account_id_value
    order by preview.preview_installation_id
    for update
  loop
    perform vortex_record.drop_preview_installation_storage(
      previous_preview.preview_installation_id
    );
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = previous_preview.preview_installation_id;
  end loop;
  perform vortex_definition.expire_preview_installations(100);

  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at, draft_shape_fingerprint
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value, p_shape_fingerprint
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases) as item(value);
  perform vortex_definition.write_preview_shape_internal(preview_installation_id_value, false);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value,
    -- The builder's live records reach the preview only through the installed Application.
    'seedable', exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = organization_id_value
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
    )
  );
end
$function$;

alter function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.create_preview_installation(uuid, bigint, jsonb, text) is
  'Replaces the builder''s 24-hour preview of one Application with a preview of its current draft: the releases its publication rehearsed, the exact Module pins they and the used Module releases name, the preview''s own permission registration whose draft roles only its builder holds, empty isolated storage for every bound record type, and the fingerprint of the draft''s data shape.';

create or replace function vortex_definition.refresh_preview_installation(
  p_preview_installation_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb,
  p_shape_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
  draft_revision_value bigint;
  application_release_revision_value bigint;
  expires_at_value timestamptz;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_shape_fingerprint is null
    or p_shape_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- A preview follows its draft in its own request: its builder, its Application, its address.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or vortex_definition.current_preview_installation_id_internal()
      is distinct from p_preview_installation_id then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  -- Reads of the preview (for key share) go on while it moves; a second move waits.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  select draft.draft_revision into draft_revision_value
  from vortex_definition.drafts as draft
  where draft.root_id = preview_row.application_root_id
  for share;
  -- A preview only moves forward, to the current draft revision.
  if not found or draft_revision_value <> p_expected_draft_revision
    or p_expected_draft_revision < preview_row.draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;
  application_release_revision_value := vortex_definition.assert_preview_releases_internal(
    preview_row.organization_id, preview_row.application_root_id, p_releases
  );

  delete from vortex_definition.preview_releases as release
  where release.preview_installation_id = p_preview_installation_id;
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select p_preview_installation_id, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases) as item(value);
  -- Its registration is written again from the new releases and draft roles.
  delete from vortex_access.preview_permission_entries as entry
  where entry.preview_installation_id = p_preview_installation_id;
  delete from vortex_access.preview_permission_registrations as registration
  where registration.preview_installation_id = p_preview_installation_id;
  expires_at_value := pg_catalog.statement_timestamp() + preview_lifetime;
  -- The release set it runs is written again, in this same request, after the new pins.
  update vortex_definition.preview_installations as preview
  set draft_revision = p_expected_draft_revision,
      application_release_revision = application_release_revision_value,
      draft_shape_fingerprint = p_shape_fingerprint,
      runtime_release_set = null,
      expires_at = expires_at_value
  where preview.preview_installation_id = p_preview_installation_id;
  perform vortex_definition.write_preview_shape_internal(p_preview_installation_id, true);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', p_preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', preview_row.created_at,
    'expiresAt', expires_at_value
  );
end
$function$;

alter function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) owner to vortex_owner;

revoke all on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text)
  to vortex_request;
comment on function vortex_definition.refresh_preview_installation(uuid, bigint, jsonb, text) is
  'Moves the builder''s preview, in its own request, to the current draft revision in place: the releases its publication rehearsed, the Module pins, its permission registration and its Record storage, keeping the records it holds, and another 24 hours. Its release set is written again in the same request. A change the stored records cannot take raises V3201.';

create or replace function vortex_definition.read_builder_preview_installation(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  identity_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation identity is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  -- A builder has at most one preview of an Application; the newest is the current one. A
  -- preview whose provisioning stopped before it wrote the release set it runs never runs, so it
  -- is not a current preview: the next request provisions one that replaces it.
  select pg_catalog.jsonb_build_object(
    'previewInstallationId', preview.preview_installation_id,
    'organizationId', preview.organization_id,
    'applicationRootId', preview.application_root_id,
    'definitionKey', root.key,
    'draftRevision', preview.draft_revision,
    'expiresAt', preview.expires_at,
    'seeded', preview.seeded_at is not null,
    'shapeFingerprint', preview.draft_shape_fingerprint,
    -- Copied live records are decided again by the builder's live access at most every five
    -- minutes, counting from the seed; reconcile_preview_installation keeps the same interval.
    'reconcileDue', preview.seeded_at is not null
      and coalesce(preview.reconciled_at, preview.seeded_at)
        <= pg_catalog.statement_timestamp() - interval '5 minutes'
  ) into identity_value
  from vortex_definition.preview_installations as preview
  join vortex_definition.roots as root on root.root_id = preview.application_root_id
  where preview.application_root_id = p_application_root_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and preview.runtime_release_set is not null
    and root.kind = 'application'
    and root.organization_id = preview.organization_id
  order by preview.created_at desc, preview.preview_installation_id desc
  limit 1;
  return identity_value;
end
$function$;

alter function vortex_definition.read_builder_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.read_builder_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_builder_preview_installation(uuid)
  to vortex_request;
comment on function vortex_definition.read_builder_preview_installation(uuid) is
  'The current runnable, unexpired preview of one Application that the builder of the validated human organisation context opened: its draft revision, the fingerprint of the draft data shape it runs, and whether it holds copied live records that are due to be decided again; null when they have none. Studio reads the canvas and Data tab records through it.';

create or replace function vortex_definition.read_preview_runtime_source(
  p_cached_draft_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid;
  if not found or preview_row.runtime_release_set is null then
    raise exception using errcode = '55000', message = 'Preview release set is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'draftRevision', preview_row.draft_revision,
    'expiresAt', preview_row.expires_at,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    -- The release set is written once for each draft revision the preview runs: a caller that
    -- already holds this revision's set gets none.
    'releaseSet', case when preview_row.draft_revision is not distinct from p_cached_draft_revision
      then null else preview_row.runtime_release_set end,
    'seedBoundedRecordTypeIds', pg_catalog.to_jsonb(preview_row.seed_bounded_record_type_ids)
  );
end
$function$;

alter function vortex_definition.read_preview_runtime_source(bigint) owner to vortex_owner;

revoke all on function vortex_definition.read_preview_runtime_source(bigint)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_runtime_source(bigint)
  to vortex_request;
comment on function vortex_definition.read_preview_runtime_source(bigint) is
  'The installation, draft revision, expiry and stored release set of the preview the validated human Application request runs, for the runtime to render it as an installed Application. The release set is left out when the caller already holds the one for the draft revision the preview runs.';

create or replace function vortex_record.copy_live_records_to_preview_internal(
  p_preview_installation_id uuid,
  p_record_type_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- The deliberate preview bound: a preview holds at most this many records of one record type,
  -- the first the builder can read in record order. The seed says when the bound was reached, and
  -- the preview tells the builder so.
  copy_limit constant integer := 2000;
  -- A table the builder can mostly not read is scanned only this far. That is a silent
  -- performance bound: it says nothing about how many live records exist.
  scan_limit constant integer := 20000;
  counter_mapping record;
  copied_maximum numeric;
  scanned_count integer := 0;
  bounded boolean := false;
  live_table_token text;
  source_module_root_id uuid;
  checked_context jsonb;
  live_type jsonb;
  preview_table_token text;
  record_columns text[];
  field_columns text[];
  readable_columns text[];
  copied_columns text;
  copied_count bigint := 0;
  live_record record;
  row_read record;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record copy selector is invalid';
  end if;
  -- The copy reads as the builder reads the installed Application: never in a preview.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
    is not null then
    raise exception using errcode = '42501', message = 'Preview record copy must read live records';
  end if;
  select catalogue.physical_table_token, catalogue.module_root_id
  into strict live_table_token, source_module_root_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  checked_context := vortex_access.validated_human_request_context();
  live_type := vortex_record.resolve_preview_seed_source_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid,
    source_module_root_id, p_record_type_id, p_live_storage_contract_id
  );
  if live_type is null or live_type ->> 'table' is distinct from live_table_token then
    raise exception using errcode = '42501', message = 'Preview seed source is not installed';
  end if;
  -- The caller passes the preview's own storage identities; both tables hold this record type.
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.record_type_id = p_record_type_id;

  -- The columns both tables declare with the same type, except the storage identity each table
  -- fixes for itself: the record columns, and each field the live release and the draft share.
  select
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname !~ '^f_[0-9a-f]{32}$'), array[]::text[]),
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname ~ '^f_[0-9a-f]{32}$'), array[]::text[])
  into record_columns, field_columns
  from pg_catalog.pg_attribute as preview_column
  join pg_catalog.pg_class as preview_table on preview_table.oid = preview_column.attrelid
  join pg_catalog.pg_namespace as preview_schema
    on preview_schema.oid = preview_table.relnamespace
  where preview_schema.nspname = 'record_data'
    and preview_table.relname = preview_table_token
    and preview_column.attnum > 0
    and not preview_column.attisdropped
    and preview_column.attname <> 'storage_contract_id'
    and exists (
      select 1
      from pg_catalog.pg_attribute as live_column
      join pg_catalog.pg_class as live_table on live_table.oid = live_column.attrelid
      join pg_catalog.pg_namespace as live_schema on live_schema.oid = live_table.relnamespace
      where live_schema.nspname = 'record_data'
        and live_table.relname = live_table_token
        and live_column.attname = preview_column.attname
        and live_column.attnum > 0
        and not live_column.attisdropped
        and live_column.atttypid = preview_column.atttypid
    );
  if pg_catalog.cardinality(record_columns) = 0
    or not ('record_id' = any(record_columns)) then
    raise exception using errcode = '55000', message = 'Preview record copy has no columns';
  end if;

  -- Only the records the builder reads in the installed Application, each with only the fields
  -- the builder reads there; every other field of a copied record is left empty. Row security
  -- limits the live table to the request's organisation and Application. The bound counts only
  -- readable records, in record order, so the builder gets the first records they can see.
  for live_record in
    execute pg_catalog.format(
      'select record_id from record_data.%I order by record_id', live_table_token
    )
  loop
    scanned_count := scanned_count + 1;
    exit when scanned_count > scan_limit;
    select projected.projection, projected.read_bounds, projected.read_facts into row_read
    from vortex_record.read_record_projection_internal(
      p_record_type_id, live_record.record_id
    ) as projected;
    continue when row_read.projection ->> 'outcome' is distinct from 'allowed';
    -- The row decision and the raw values must refer to the same authoritative storage,
    -- including if the installed pin set changed since the source was resolved.
    if (row_read.read_facts #>> '{facts,binding,storageContractId}')::uuid
      is distinct from p_live_storage_contract_id then
      raise exception using errcode = '42501', message = 'Preview seed authorization storage changed';
    end if;
    if copied_count = copy_limit then
      bounded := true;
      exit;
    end if;
    select coalesce(pg_catalog.array_agg(field_column.value order by field_column.value), array[]::text[])
    into readable_columns
    from pg_catalog.unnest(field_columns) as field_column(value)
    where field_column.value in (
      select 'f_' || pg_catalog.replace(pg_catalog.lower(readable.value #>> '{}'), '-', '')
      from pg_catalog.jsonb_array_elements(row_read.read_bounds -> 'readableFieldIds') as readable(value)
    );
    select pg_catalog.string_agg(pg_catalog.quote_ident(copied.value), ', ')
    into copied_columns
    from pg_catalog.unnest(record_columns || readable_columns) as copied(value);
    execute pg_catalog.format(
      'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I where record_id = $1',
      preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
      live_table_token
    ) using live_record.record_id;
    copied_count := copied_count + 1;
  end loop;

  -- Each reference-number counter continues after the highest number among the copied records,
  -- never from the live counter, which would reveal how many live records exist.
  for counter_mapping in
    select mapping.field_id, mapping.physical_column_token
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_preview_storage_contract_id
      and mapping.state = 'active'
      and mapping.field_definition ->> 'type' = 'reference_number'
      and mapping.physical_column_token = any(field_columns)
    order by mapping.field_id
  loop
    execute pg_catalog.format(
      'select pg_catalog.max(pg_catalog.substring(%I, ''([0-9]+)[^0-9]*$'')::numeric) from record_data.%I where storage_contract_id = %L::uuid',
      counter_mapping.physical_column_token, preview_table_token, p_preview_storage_contract_id
    ) into copied_maximum;
    if copied_maximum is not null then
      insert into vortex_record.preview_reference_counters (
        preview_installation_id, storage_contract_id, field_id, next_number
      ) values (
        p_preview_installation_id, p_preview_storage_contract_id, counter_mapping.field_id,
        copied_maximum + 1
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('copied', copied_count, 'bounded', bounded);
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record copy storage is unavailable';
end
$function$;

alter function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid) is
  'Seeds one preview record table with the live records of the same record type that the request''s builder reads in the installed Application, each with only the fields they read there, and reference counters that continue after the copied records: the first 2,000 they read, in record order, and whether they read more.';

create or replace function vortex_definition.seed_preview_installation(
  p_preview_installation_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  storage_identity jsonb;
  copy_result jsonb;
  seeded_count bigint := 0;
  bounded_ids uuid[] := array[]::uuid[];
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- The seed reads the installed Application as its builder reads it: the request runs in the
  -- installed Application's own context, never in the preview.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
      is not null then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  if preview_row.seeded_at is not null or preview_row.runtime_release_set is not null then
    raise exception using errcode = '55000', message = 'Preview installation is already seeded';
  end if;

  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    order by identity.value ->> 'previewStorageContractId'
  loop
    -- Only an installed live type is seedable. New draft types start empty; an existing
    -- catalogue entry alone never makes a source readable through this installation.
    if vortex_record.resolve_preview_seed_source_internal(
      preview_row.organization_id, preview_row.application_root_id,
      (storage_identity ->> 'moduleRootId')::uuid,
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid
    ) is null then
      continue;
    end if;
    copy_result := vortex_record.copy_live_records_to_preview_internal(
      p_preview_installation_id,
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid,
      (storage_identity ->> 'previewStorageContractId')::uuid
    );
    seeded_count := seeded_count + (copy_result ->> 'copied')::bigint;
    if (copy_result ->> 'bounded')::boolean then
      bounded_ids := bounded_ids || (storage_identity ->> 'recordTypeId')::uuid;
    end if;
  end loop;
  update vortex_definition.preview_installations as preview
  set seeded_at = pg_catalog.statement_timestamp(),
      seed_bounded_record_type_ids = bounded_ids
  where preview.preview_installation_id = p_preview_installation_id;
  return seeded_count;
end
$function$;

alter function vortex_definition.seed_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.seed_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.seed_preview_installation(uuid) to vortex_request;
comment on function vortex_definition.seed_preview_installation(uuid) is
  'Seeds a new preview''s storage, once, with the live records its builder reads in the installed Application and only the fields they read there, at most 2,000 per record type, and records the record types that reached that bound. A preview never shows more than its builder sees live, plus what they create in it.';

reset role;
