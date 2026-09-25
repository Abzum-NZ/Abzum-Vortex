-- #996: cache each installation's access plan per binding revision.
--
-- For every row a list checks, the record-access fact loader reloaded every
-- bound Module release and re-validated storage. The access plan resolves the
-- definitions, column maps, permission alternatives and compiled saved
-- conditions once, keyed by the exact installation pins (each binding's
-- binding revision, its Module release revision and the Application release
-- revision). A binding revision advances on every installation lifecycle
-- transition and a release revision is immutable, so a stale plan can never be
-- selected and a plan can never grant access the live pins do not. Only an
-- all-active pin set is stored: storage adoption never retires a field mapping
-- an active binding's release declares, but it can retire one a detached
-- binding's release declares, so a detached pin set is resolved afresh on each
-- call and keeps refusing retired storage exactly as before. The table is
-- append-only and not yet evicted; eviction belongs to the runtime-bundle
-- lifecycle (architecture Decision 9).
--
-- The plan is stored in vortex_record.installation_access_plans and built by
-- vortex_record.resolve_installation_access_plan_internal. Both fact loaders
-- now share one closure implementation,
-- vortex_record.load_record_access_facts_from_installation_internal:
-- load_record_access_facts_internal keeps its signature and reads the active
-- installation, and the ownership-transfer twin keeps its signature and reads
-- the supplied exact installation with the transfer action kind. The detached
-- duplicate of the definition-resolution body is gone.
--
-- Each function is stated in full, identical to its canonical file
-- supabase/schemas/vortex_record/<function>.sql changed in this commit.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;

create table vortex_record.installation_access_plans (
  plan_key text not null check (plan_key ~ '^sha256:[a-f0-9]{64}$'),
  organization_id uuid not null,
  application_root_id uuid not null,
  application_release_revision bigint not null
    check (application_release_revision between 1 and 9007199254740991),
  plan jsonb not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint installation_access_plans_pk primary key (plan_key)
);

alter table vortex_record.installation_access_plans enable row level security;
alter table vortex_record.installation_access_plans force row level security;
create policy installation_access_plans_adapter
  on vortex_record.installation_access_plans to vortex_record_adapter
  using (true) with check (true);
alter table vortex_record.installation_access_plans owner to vortex_record_adapter;
revoke all on table vortex_record.installation_access_plans
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_request, vortex_record_owner, vortex_module_owner;


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
        or catalogue_row.physical_schema_token <> 'record_data'
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

create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  plan jsonb;
  type_meta jsonb := '{}'::jsonb;
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
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore', 'transfer')
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

  -- Step 2: the exact installation supplied by the trusted caller. Its reader
  -- owns the pin-set rules; this adapter consumes them and adds none.
  -- Step 3: the cached access plan. Definitions, column maps, permission
  -- alternatives and saved conditions are resolved once per installation
  -- binding revision and reused by every load below.
  plan := vortex_record.resolve_installation_access_plan_internal(p_installation);
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  type_meta := plan -> 'recordTypes';
  relationship_by_id := plan -> 'relationships';
  condition_list := plan -> 'sharingConditions';
  permission_by_id := plan -> 'permissions';

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the declaration. Every record-scoped permission of this action
  -- kind declared for this exact record type, owned by the context Application
  -- or by the record type's own Module, in the canonical order the eligibility
  -- core requires.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = p_action_kind
    -- `->>` and not `->`: a permission that declares no named action is stored
    -- here as JSON null, which `-> 'namedAction' is null` would never match, so
    -- that test would leave every declaration empty and refuse every record.
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = target_module_root_id
    );

  declaration := case
    when required_permissions is null then null
    else pg_catalog.jsonb_build_object(
      'operationKey', 'record.' || p_action_kind,
      'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', target_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  end;

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
    target_meta ->> 'valueExpression', target_table,
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
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
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
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
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

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) to vortex_record_adapter;

comment on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) is
  'Private adapter fact loader over one exact trusted installation, resolving definitions from the cached installation access plan.';

create or replace function vortex_record.load_record_access_facts_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_application_root_id uuid;
  installation jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context, checked here so the active reader
  -- and the shared loader refuse an absent Application context identically.
  context_value := vortex_access.validated_human_request_context();
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; the shared loader consumes them and adds none.
  installation := vortex_module.read_current_active_installation();

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, p_action_kind, p_record_id, p_expected_concurrency_number, installation
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

revoke all on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) is
  'Private adapter fact loader over the exact active installation, including each pinned Module validation contract version.';

create or replace function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, 'transfer', p_record_id, p_expected_concurrency_number, p_installation
  );
end
$function$;

revoke all on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) to vortex_record_adapter;
comment on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) is
  'Private complete record-scope fact loader for transfer, parameterised only by an exact trusted installation.';


reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;

