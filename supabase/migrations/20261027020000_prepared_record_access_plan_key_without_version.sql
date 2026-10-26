-- The prepared Record access plan key hashed a ".v2" domain tag although no other version exists
-- (ARCH4 D4). The three functions that compute the key drop the suffix; each is re-created from its
-- canonical file. Stored keys are rewritten in place below so every active installation keeps its
-- bundle: the stored plan row, the bundle's source manifest and its access plan section parts (with
-- their recorded sha256), all under the new key. Both keys are "sha256:" plus 64 hex characters, so
-- the rewrite keeps every part's byte size and boundary.
set role vortex_record_adapter;

create or replace function vortex_record.resolve_prepared_record_access_plan_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  pin_fingerprint_value text;
  current_mapping jsonb;
  current_bindings jsonb;
  resolved_plan jsonb;
  mapping_fingerprint_value text;
  plan_key_value text;
  prepared_plan jsonb;
  stored_plan vortex_record.installation_access_plans%rowtype;
  inserted_rows bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1 then
    raise exception using errcode = '22023',
      message = 'Prepared Record access plan command is invalid';
  end if;

  select locked.* into current_mapping
  from vortex_definition.lock_prepared_installation_runtime_mapping_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  ) as locked;
  organization_id_value := (current_mapping ->> 'organizationId')::uuid;
  application_root_id_value := (current_mapping ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (current_mapping ->> 'applicationReleaseRevision')::bigint;
  pin_fingerprint_value := current_mapping ->> 'pinFingerprint';
  if current_mapping is null
    or application_root_id_value is distinct from p_application_root_id
    or application_release_revision_value is distinct from p_application_release_revision
    or pin_fingerprint_value is null
    or pin_fingerprint_value !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '40001',
      message = 'Prepared Record access plan mapping changed';
  end if;
  current_bindings := current_mapping -> 'moduleBindings';
  resolved_plan := vortex_record.resolve_installation_access_plan_internal(
    pg_catalog.jsonb_build_object(
      'organizationId', organization_id_value,
      'applicationRootId', application_root_id_value,
      'applicationReleaseRevision', application_release_revision_value,
      'moduleBindings', current_bindings
    ),
    false
  );
  if resolved_plan is null
    or (resolved_plan ->> 'organizationId')::uuid is distinct from organization_id_value
    or (resolved_plan ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (resolved_plan ->> 'applicationReleaseRevision')::bigint
      is distinct from application_release_revision_value then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan is unavailable';
  end if;

  -- The projection kind is private access-loader metadata. Runtime bundles
  -- retain their existing prepared plan contract and mapping fingerprint.
  resolved_plan := pg_catalog.jsonb_set(
    resolved_plan, '{recordTypes}', coalesce((
      select pg_catalog.jsonb_object_agg(meta.key, meta.value - 'isSystemProjection')
      from pg_catalog.jsonb_each(resolved_plan -> 'recordTypes') as meta(key, value)
    ), '{}'::jsonb)
  );

  mapping_fingerprint_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      (pg_catalog.jsonb_build_object(
        'recordTypes', resolved_plan -> 'recordTypes',
        'relationships', resolved_plan -> 'relationships',
        'sharingConditions', resolved_plan -> 'sharingConditions',
        'permissions', resolved_plan -> 'permissions'
      ))::text,
      'UTF8'
    )),
    'hex'
  );
  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'vortex.installation-runtime-bundle.prepared-record-access-plan|' ||
        organization_id_value::text || '|' || application_root_id_value::text || '|' ||
        application_release_revision_value::text || '|2|' || pin_fingerprint_value,
      'UTF8'
    )),
    'hex'
  );
  prepared_plan := pg_catalog.jsonb_build_object(
    'planKey', plan_key_value,
    'mappingFingerprint', mapping_fingerprint_value,
    'plan', resolved_plan
  );

  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id, application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, prepared_plan
  ) on conflict (plan_key) do nothing;
  get diagnostics inserted_rows = row_count;
  if inserted_rows = 0 then
    select stored.* into strict stored_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value
    for update;
    if stored_plan.organization_id is distinct from organization_id_value
      or stored_plan.application_root_id is distinct from application_root_id_value
      or stored_plan.application_release_revision is distinct from application_release_revision_value
      or stored_plan.plan is distinct from prepared_plan then
      raise exception using errcode = '23505',
        message = 'Prepared Record access plan immutable identity differs';
    end if;
    prepared_plan := stored_plan.plan;
  end if;
  return prepared_plan;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared Record access plan evidence is ambiguous';
end
$function$;
alter function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb)
  to vortex_owner;
comment on function vortex_record.resolve_prepared_record_access_plan_internal(uuid,bigint,jsonb) is
  'Resolves and immutably stores the exact prepared Record access plan for a first-install provisioned Module mapping.';

create or replace function vortex_record.resolve_active_bundle_record_access_plan_internal(p_expected_identity jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare

  plan_key_value text;
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
  p_installation jsonb;
  active_mapping jsonb;
  final_mapping jsonb;
  storage_item record;
  stable_plan jsonb;
  stored_plan_row vortex_record.installation_access_plans%rowtype;
  inserted_rows bigint;
  mapping_fingerprint_value text;
  pin_fingerprint_value text;
begin
  active_mapping:=vortex_definition.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  p_installation:=active_mapping -> 'installation';
  organization_id_value:=(p_installation ->> 'organizationId')::uuid;
  application_root_id_value:=(p_installation ->> 'applicationRootId')::uuid;
  application_release_revision_value:=(p_installation ->> 'applicationReleaseRevision')::bigint;
  -- This fixed active-only composer exposes no preview or binding-state override.
  pin_fingerprint_value:=active_mapping #>> '{identity,pinFingerprint}';
  -- Reuse the storage mutators' existing advisory key, without requesting
  -- row-lock UPDATE authority on SELECT-only storage catalogue tables.
  for storage_item in
    select distinct (record_type.value ->> 'storageContractId')::uuid as storage_id
    from pg_catalog.jsonb_array_elements(active_mapping -> 'modules') as module(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      module.value #> '{compilationOutput,canonical,content,recordTypes}') as record_type(value)
    order by storage_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vortex_record.storage:' || storage_item.storage_id::text,0));
    final_mapping:=vortex_definition.lock_active_installation_runtime_mapping_internal(p_expected_identity);
    if final_mapping is distinct from active_mapping then
      raise exception using errcode='40001', message='Active Record mapping changed while waiting';
    end if;
  end loop;
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
      release_storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;
      storage_contract_value := release_storage_contract_value;

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
            and release_storage_contract_value = any (provision.storage_contract_ids)
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
  into strict release_content from vortex_definition.releases as release
  where release.root_id=application_root_id_value
    and release.release_revision=application_release_revision_value;

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


  mapping_fingerprint_value:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'recordTypes',plan -> 'recordTypes','relationships',plan -> 'relationships',
      'sharingConditions',plan -> 'sharingConditions','permissions',plan -> 'permissions')::text,'UTF8')),'hex');
  plan_key_value:='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'vortex.installation-runtime-bundle.prepared-record-access-plan|' ||
      organization_id_value::text || '|' || application_root_id_value::text || '|' ||
      application_release_revision_value::text || '|2|' || pin_fingerprint_value,'UTF8')),'hex');
  stable_plan:=pg_catalog.jsonb_build_object('planKey',plan_key_value,
    'mappingFingerprint',mapping_fingerprint_value,'plan',plan);
  insert into vortex_record.installation_access_plans(
    plan_key,organization_id,application_root_id,application_release_revision,plan)
  values(plan_key_value,organization_id_value,application_root_id_value,
    application_release_revision_value,stable_plan)
  on conflict(plan_key) do nothing;
  get diagnostics inserted_rows=row_count;
  if inserted_rows=0 then
    select stored.* into strict stored_plan_row
    from vortex_record.installation_access_plans as stored where stored.plan_key=plan_key_value for update;
    if stored_plan_row.organization_id is distinct from organization_id_value
      or stored_plan_row.application_root_id is distinct from application_root_id_value
      or stored_plan_row.application_release_revision is distinct from application_release_revision_value
      or stored_plan_row.plan is distinct from stable_plan then
      raise exception using errcode='23505', message='Active Record plan immutable identity differs';
    end if;
  end if;
  final_mapping:=vortex_definition.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  if final_mapping is distinct from active_mapping then
    raise exception using errcode='40001', message='Active Record mapping changed';
  end if;
  return stable_plan;
exception when no_data_found or too_many_rows then
  raise exception using errcode='55000', message='Active Record plan evidence is unavailable';
end
$function$;
alter function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb) to vortex_record_adapter, vortex_owner;
comment on function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb) is 'Derives the full active declared Record plan under current binding and storage locks, using the same immutable format2 plan identity as first preparation.';
reset role;

set role vortex_owner;

create or replace function vortex_definition.read_active_installation_bundle_identity()
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare
  checked_context jsonb;
  selected_org uuid;
  selected_app uuid;
  selected_revision bigint;
  active_count integer;
  registered_app record;
  registered_identity jsonb;
  bindings jsonb;
  pin_facts jsonb;
  pin_hash text;
  identity_value jsonb;
  before_identity jsonb;
  stored_bundle vortex_definition.installation_runtime_bundles%rowtype;
  bundle_index jsonb;
  current_manifest jsonb;
  manifest_pins jsonb;
  mapping jsonb;
  stable_plan jsonb;
  active_source jsonb;
  source_manifest jsonb;
begin
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_definition.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_definition.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  before_identity:=identity_value;
  select stored.* into stored_bundle from vortex_definition.installation_runtime_bundles as stored
  where stored.organization_id=selected_org and stored.application_root_id=selected_app
    and stored.application_release_revision=selected_revision and stored.bundle_format_version=2;
  if found then
    current_manifest:=stored_bundle.source_manifest;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',module.value -> 'rootId','moduleReleaseRevision',module.value -> 'releaseRevision',
      'contentFingerprint',module.value -> 'contentFingerprint',
      'resolutionFingerprint',module.value -> 'resolutionFingerprint')
      order by (module.value ->> 'rootId')::uuid)
    into manifest_pins from pg_catalog.jsonb_array_elements(current_manifest -> 'modules') as module(value);
    if current_manifest ->> 'bundleFormatVersion' is distinct from '2'
      or current_manifest -> 'application' is distinct from registered_identity
      or current_manifest ->> 'pinFingerprint' is distinct from pin_hash
      or stored_bundle.pin_fingerprint is distinct from pin_hash
      or manifest_pins is distinct from pin_facts
      or pg_catalog.jsonb_typeof(current_manifest -> 'preparedRecordAccessPlan') is distinct from 'object'
      or current_manifest #>> '{preparedRecordAccessPlan,planKey}' is distinct from (
        'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          'vortex.installation-runtime-bundle.prepared-record-access-plan|' ||
            selected_org::text || '|' || selected_app::text || '|' ||
            selected_revision::text || '|2|' || pin_hash,'UTF8')),'hex'))
      or current_manifest #>> '{preparedRecordAccessPlan,mappingFingerprint}' is null
      or (current_manifest #>> '{preparedRecordAccessPlan,planKey}') !~ '^sha256:[a-f0-9]{64}$'
      or (current_manifest #>> '{preparedRecordAccessPlan,mappingFingerprint}') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode='23514', message='Active runtime bundle manifest differs';
    end if;
    bundle_index:=vortex_definition.read_installation_runtime_bundle_index(selected_app,selected_revision,2);
  else
    -- Missing format2 takes a genuine locked active-only cold source path.
    -- The mapping locker derives identity inline and cannot recurse into this reader.
    mapping:=vortex_definition.lock_active_installation_runtime_mapping_internal(before_identity);
    stable_plan:=vortex_record.resolve_active_bundle_record_access_plan_internal(before_identity);
    active_source:=pg_catalog.jsonb_build_object(
      'organizationId',mapping #> '{identity,organizationId}',
      'applicationRootId',mapping #> '{identity,applicationRootId}',
      'applicationReleaseRevision',mapping #> '{identity,applicationReleaseRevision}',
      'accessVersion',mapping #> '{identity,accessVersion}',
      'correlationId',mapping #> '{identity,correlationId}',
      'pinFingerprint',mapping #> '{identity,pinFingerprint}',
      'mappingFingerprint',stable_plan -> 'mappingFingerprint',
      'moduleBindings',mapping #> '{identity,moduleBindings}',
      'application',mapping -> 'application','modules',mapping -> 'modules',
      'preparedRecordAccessPlan',stable_plan);
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', active_source #> '{application,rootId}',
      'definitionKey', active_source #> '{application,key}',
      'releaseRevision', active_source #> '{application,releaseRevision}',
      'releaseVersion', active_source #> '{application,releaseVersion}',
      'validationContractVersion', active_source #> '{application,validationContractVersion}',
      'contentFingerprint', active_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', active_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', active_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', active_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', active_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );

    active_source:=active_source || pg_catalog.jsonb_build_object('sourceManifest',source_manifest);
  end if;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_definition.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_definition.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  if identity_value is distinct from before_identity then
    raise exception using errcode='40001', message='Active runtime bundle identity changed';
  end if;
  return pg_catalog.jsonb_build_object('identity',identity_value,
    'bundleIndex',bundle_index,'repairNeeded',bundle_index is null,'coldSource',active_source);
exception when no_data_found or too_many_rows then
  raise exception using errcode='P0002', message='Active runtime bundle identity is unavailable';
end
$function$;
alter function vortex_definition.read_active_installation_bundle_identity() owner to vortex_owner;
revoke all on function vortex_definition.read_active_installation_bundle_identity()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.read_active_installation_bundle_identity() to vortex_owner, vortex_request;
comment on function vortex_definition.read_active_installation_bundle_identity() is 'Returns fresh active format2 identity and index, or a private exact locked active cold source for the same HUMAN request; carries no viewer permission decision.';
reset role;

create temporary table prepared_plan_key_rewrites (
  old_key text primary key,
  new_key text not null unique
);
grant select, insert on prepared_plan_key_rewrites to vortex_owner;
grant select on prepared_plan_key_rewrites to vortex_record_adapter;

set role vortex_owner;

do $rewrite$
declare
  bundle_row record;
  old_key text;
  new_key text;
  section_text text;
  rewritten bytea;
  part_row record;
  part_offset integer;
  part_bytes bytea;
begin
  for bundle_row in
    select bundle.*
    from vortex_definition.installation_runtime_bundles as bundle
    where bundle.bundle_format_version = 2
    order by bundle.organization_id, bundle.application_root_id, bundle.application_release_revision
    for update
  loop
    old_key := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'vortex.installation-runtime-bundle.prepared-record-access-plan.v2|' ||
        bundle_row.organization_id::text || '|' || bundle_row.application_root_id::text || '|' ||
        bundle_row.application_release_revision::text || '|2|' || bundle_row.pin_fingerprint,
      'UTF8')), 'hex');
    -- A bundle whose manifest already differs is refused by its reader either way; leave it.
    continue when bundle_row.source_manifest #>> '{preparedRecordAccessPlan,planKey}'
      is distinct from old_key;
    new_key := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'vortex.installation-runtime-bundle.prepared-record-access-plan|' ||
        bundle_row.organization_id::text || '|' || bundle_row.application_root_id::text || '|' ||
        bundle_row.application_release_revision::text || '|2|' || bundle_row.pin_fingerprint,
      'UTF8')), 'hex');

    select pg_catalog.convert_from(pg_catalog.string_agg(part.content_bytes, ''::bytea
      order by part.ordinal), 'UTF8')
    into section_text
    from vortex_definition.installation_runtime_bundle_parts as part
    where part.organization_id = bundle_row.organization_id
      and part.application_root_id = bundle_row.application_root_id
      and part.application_release_revision = bundle_row.application_release_revision
      and part.bundle_format_version = 2
      and part.section = 'access_plan';
    if section_text is null or pg_catalog.strpos(section_text, old_key) = 0 then
      raise exception using errcode = '55000',
        message = 'Runtime bundle access plan section does not hold its plan key';
    end if;
    rewritten := pg_catalog.convert_to(pg_catalog.replace(section_text, old_key, new_key), 'UTF8');

    part_offset := 0;
    for part_row in
      select part.ordinal, pg_catalog.octet_length(part.content_bytes) as byte_size
      from vortex_definition.installation_runtime_bundle_parts as part
      where part.organization_id = bundle_row.organization_id
        and part.application_root_id = bundle_row.application_root_id
        and part.application_release_revision = bundle_row.application_release_revision
        and part.bundle_format_version = 2
        and part.section = 'access_plan'
      order by part.ordinal
    loop
      part_bytes := pg_catalog.substring(rewritten, part_offset + 1, part_row.byte_size);
      part_offset := part_offset + part_row.byte_size;
      update vortex_definition.installation_runtime_bundle_parts as part
      set content_bytes = part_bytes
      where part.organization_id = bundle_row.organization_id
        and part.application_root_id = bundle_row.application_root_id
        and part.application_release_revision = bundle_row.application_release_revision
        and part.bundle_format_version = 2
        and part.section = 'access_plan'
        and part.ordinal = part_row.ordinal;
      bundle_row.parts := (
        select pg_catalog.jsonb_agg(
          case when item.value ->> 'section' = 'access_plan'
              and (item.value ->> 'ordinal')::integer = part_row.ordinal
            then item.value || pg_catalog.jsonb_build_object('sha256', 'sha256:' ||
              pg_catalog.encode(extensions.digest(part_bytes, 'sha256'), 'hex'))
            else item.value end
          order by item.ordinality)
        from pg_catalog.jsonb_array_elements(bundle_row.parts) with ordinality as item(value, ordinality)
      );
    end loop;
    if part_offset <> pg_catalog.octet_length(rewritten) then
      raise exception using errcode = '55000',
        message = 'Runtime bundle access plan section changed length';
    end if;

    update vortex_definition.installation_runtime_bundles as bundle
    set parts = bundle_row.parts,
      source_manifest = pg_catalog.jsonb_set(
        bundle_row.source_manifest, '{preparedRecordAccessPlan,planKey}', pg_catalog.to_jsonb(new_key))
    where bundle.organization_id = bundle_row.organization_id
      and bundle.application_root_id = bundle_row.application_root_id
      and bundle.application_release_revision = bundle_row.application_release_revision
      and bundle.bundle_format_version = 2;

    insert into prepared_plan_key_rewrites (old_key, new_key) values (old_key, new_key);
  end loop;
end
$rewrite$;

reset role;

set role vortex_record_adapter;

do $rewrite$
begin
  update vortex_record.installation_access_plans as plan
  set plan_key = rewrite.new_key,
    plan = pg_catalog.jsonb_set(plan.plan, '{planKey}', pg_catalog.to_jsonb(rewrite.new_key))
  from prepared_plan_key_rewrites as rewrite
  where plan.plan_key = rewrite.old_key;

  -- Prepared plans no bundle holds are rebuilt under the new key when next prepared.
  delete from vortex_record.installation_access_plans as plan
  where plan.plan ? 'mappingFingerprint'
    and plan.plan ->> 'planKey' = plan.plan_key
    and not exists (
      select 1 from prepared_plan_key_rewrites as rewrite where rewrite.new_key = plan.plan_key
    );
end
$rewrite$;

reset role;

drop table prepared_plan_key_rewrites;
