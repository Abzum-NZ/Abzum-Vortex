-- Private Record lifecycle/storage primitives (#402).
--
-- These functions are deliberately not request-callable.  They are the
-- transaction-local storage operations which #47's one protected save command
-- will compose with validation, Activity, Event and receipts.  All dynamic
-- identifiers come from the owner-only storage catalogue; request data can
-- never name a schema, table, column, permission, definition or access graph.

-- One counter row represents one published reference-number field in one
-- storage scope.  PostgreSQL 15 NULLS NOT DISTINCT gives organization-shared
-- rows a real unique identity without inventing an Application sentinel.
set local role vortex_record_owner;

create table vortex_record.record_reference_counters (
  counter_id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  field_id uuid not null,
  application_root_id uuid,
  next_number numeric(78, 0) not null check (next_number >= 1),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  foreign key (storage_contract_id, field_id)
    references vortex_record.field_storage_mappings (storage_contract_id, field_id),
  unique nulls not distinct (
    organization_id, storage_contract_id, field_id, application_root_id
  )
);

create table vortex_record.record_data_versions (
  data_version_id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  application_root_id uuid,
  data_version bigint not null check (data_version between 1 and 9007199254740991),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique nulls not distinct (organization_id, storage_contract_id, application_root_id)
);

alter table vortex_record.record_reference_counters enable row level security;
alter table vortex_record.record_reference_counters force row level security;
alter table vortex_record.record_data_versions enable row level security;
alter table vortex_record.record_data_versions force row level security;

create policy record_reference_counters_owner
  on vortex_record.record_reference_counters to vortex_record_owner
  using (true) with check (true);
create policy record_reference_counters_adapter
  on vortex_record.record_reference_counters to vortex_record_adapter
  using (organization_id = vortex_context.organization_id())
  with check (organization_id = vortex_context.organization_id());
create policy record_data_versions_owner
  on vortex_record.record_data_versions to vortex_record_owner
  using (true) with check (true);
create policy record_data_versions_adapter
  on vortex_record.record_data_versions to vortex_record_adapter
  using (organization_id = vortex_context.organization_id())
  with check (organization_id = vortex_context.organization_id());

alter table vortex_record.record_reference_counters owner to vortex_record_owner;
alter table vortex_record.record_data_versions owner to vortex_record_owner;
grant select, insert, update on vortex_record.record_reference_counters,
  vortex_record.record_data_versions to vortex_record_adapter;

-- Relationship mutation stays behind the private Record primitives.  The
-- adapter receives only the INSERT/DELETE table privileges those primitives
-- require, constrained to the current organisation by forced RLS.
grant insert, delete on vortex_record.relationship_edges to vortex_record_adapter;
create policy relationship_edges_adapter_insert
  on vortex_record.relationship_edges for insert to vortex_record_adapter
  with check (
    from_organisation_id = vortex_context.organization_id()
    and to_organisation_id = vortex_context.organization_id()
  );
create policy relationship_edges_adapter_delete
  on vortex_record.relationship_edges for delete to vortex_record_adapter
  using (from_organisation_id = vortex_context.organization_id());

-- Group ownership needs exactly one narrow Access-owned fact check.  Record is
-- not granted broad reads over the Group or membership ledgers.
reset role;
create function vortex_access.lock_current_record_owner_group_internal(
  p_group_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  matched boolean;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select true into matched
  from vortex_access.organization_groups as organization_group
  join vortex_access.organization_group_memberships as membership
    on membership.organization_id = organization_group.organization_id
    and membership.group_id = organization_group.group_id
  where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
    and organization_group.group_id = p_group_id
    and organization_group.state = 'active'
    and membership.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and membership.state = 'live'
    and membership.starts_at <= pg_catalog.statement_timestamp()
    and (membership.expires_at is null
      or membership.expires_at > pg_catalog.statement_timestamp())
  for share of organization_group, membership;
  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_access.lock_current_record_owner_group_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner, vortex_record_owner;
grant execute on function vortex_access.lock_current_record_owner_group_internal(uuid)
  to vortex_record_adapter;
comment on function vortex_access.lock_current_record_owner_group_internal(uuid) is
  'Private current Group-membership check used only by the Record create primitive; locks the exact active Group and live membership for the transaction.';

reset role;
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;
alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;

-- #401's facts loader is already action-generic apart from its closed selector.
-- Extend that exact owner function in place so delete/restore/create build their
-- fact closure from their own permission routes while retaining the existing
-- target-row lock and every prior read/update behavior.  The exact replacement
-- guard makes migration drift fail instead of silently editing an unexpected
-- function body or copying the large facts engine into a second implementation.
do $migration$
declare
  existing_definition text;
  extended_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint)'::pg_catalog.regprocedure
  ) into strict existing_definition;
  extended_definition := pg_catalog.replace(
    existing_definition,
    'or p_action_kind not in (''read'', ''update'')',
    'or p_action_kind not in (''create'', ''read'', ''update'', ''delete'', ''restore'')'
  );
  if extended_definition = existing_definition then
    raise exception using errcode = '55000',
      message = 'Record facts loader selector does not match its reviewed prerequisite';
  end if;
  execute extended_definition;
end
$migration$;

-- Resolve one action against the exact active installation.  This is the
-- create/delete/restore counterpart of #401's row facts loader: it returns
-- only catalogue-derived physical tokens and the canonical action declaration.
create function vortex_record.resolve_record_action_context_internal(
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
    or catalogue_row.physical_schema_token <> 'record_data'
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

create function vortex_record.bump_record_data_version_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  result_version bigint;
begin
  insert into vortex_record.record_data_versions (
    organization_id, storage_contract_id, application_root_id, data_version
  ) values (p_organization_id, p_storage_contract_id, p_application_root_id, 1)
  on conflict (organization_id, storage_contract_id, application_root_id)
    do update set data_version = vortex_record.record_data_versions.data_version + 1,
      changed_at = pg_catalog.statement_timestamp()
    where vortex_record.record_data_versions.data_version < 9007199254740991
  returning data_version into result_version;
  if result_version is null then
    raise exception using errcode = '22003', message = 'Record data version is exhausted';
  end if;
  return result_version;
end
$function$;

create function vortex_record.allocate_reference_number_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_application_root_id uuid,
  p_settings jsonb
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  start_number numeric(78,0);
  allocated numeric(78,0);
  digit_width integer;
  prefix_value text;
  suffix_value text;
begin
  if pg_catalog.jsonb_typeof(p_settings) <> 'object'
    or pg_catalog.jsonb_typeof(p_settings -> 'digits') <> 'number'
    or (p_settings ->> 'digits')::integer not between 1 and 20
    or (p_settings ? 'startingNumber' and (
      pg_catalog.jsonb_typeof(p_settings -> 'startingNumber') <> 'number'
      or (p_settings ->> 'startingNumber')::numeric < 1
      or pg_catalog.trunc((p_settings ->> 'startingNumber')::numeric)
        <> (p_settings ->> 'startingNumber')::numeric
    )) then
    raise exception using errcode = '22023', message = 'Reference-number settings are invalid';
  end if;
  digit_width := (p_settings ->> 'digits')::integer;
  start_number := coalesce((p_settings ->> 'startingNumber')::numeric, 1);
  prefix_value := coalesce(p_settings ->> 'prefix', '');
  suffix_value := coalesce(p_settings ->> 'suffix', '');

  insert into vortex_record.record_reference_counters (
    organization_id, storage_contract_id, field_id, application_root_id, next_number
  ) values (
    p_organization_id, p_storage_contract_id, p_field_id, p_application_root_id,
    start_number + 1
  )
  on conflict (organization_id, storage_contract_id, field_id, application_root_id)
    do update set next_number = vortex_record.record_reference_counters.next_number + 1,
      changed_at = pg_catalog.statement_timestamp()
  returning next_number - 1 into allocated;

  return prefix_value
    || pg_catalog.lpad(
      allocated::text,
      case when pg_catalog.length(allocated::text) > digit_width
        then pg_catalog.length(allocated::text) else digit_width end,
      '0'
    )
    || suffix_value;
end
$function$;

-- Store one to-record value and its relationship edge as one change.  The
-- helper is private and assumes its caller has already decided authority over
-- the source record; it independently requires current read eligibility for
-- the selected target.
create function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  existing_other boolean;
  target_locked boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_increment_source_revision is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id =
      (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null%s
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token',
      case when p_increment_source_revision then
        ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $3'
      else '' end
    );
    if p_increment_source_revision then
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id, (source_context ->> 'organizationAccountId')::uuid;
    else
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id;
    end if;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    if p_increment_source_revision then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;

  -- Prevent a selected target disappearing while its unconstrainted edge is
  -- installed. EXECUTE does not update PL/pgSQL FOUND, so capture the selected
  -- value explicitly. Then rebuild eligibility from the now-locked current row
  -- rather than trusting a decision made before a concurrent deletion waited.
  target_locked := false;
  execute pg_catalog.format(
    'select true from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active'' for share',
    target_meta ->> 'table'
  ) into target_locked using
    (source_context ->> 'organizationId')::uuid, target_record_id;
  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  target_loaded := vortex_record.load_record_access_facts_internal(
    target_type_id, 'read', target_record_id, null
  );
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_record.relationship:' || p_relationship_id::text || ':' || target_record_id::text,
    0
  ));
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  );
  if p_increment_source_revision then
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value,
      (source_context ->> 'organizationAccountId')::uuid;
  else
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value;
  end if;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
  if p_increment_source_revision then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
end
$function$;

create function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  submitted_id uuid;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    if pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;

    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'team' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(vortex_record.allocate_reference_number_internal(
          (context_value ->> 'organizationId')::uuid,
          (meta ->> 'storageContractId')::uuid,
          field_id_value, app_scope, field_item -> 'settings'
        ));
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      column_names := pg_catalog.array_append(
        column_names, pg_catalog.format('%I', column_value ->> 'token')
      );
      column_values := pg_catalog.array_append(column_values,
        case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
          when 'timestamp_with_time_zone' then
            pg_catalog.format('%L::timestamptz', input_value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
          else pg_catalog.format('%L::text', input_value #>> '{}')
        end end
      );
    end loop;

    insert_sql := pg_catalog.format(
      'insert into record_data.%I (
         organisation_id, module_root_id, record_type_id, storage_contract_id,
         record_id, application_root_id, definition_revision,
         owner_organisation_account_id, owner_group_id, lifecycle_state,
         concurrency_number, created_at, created_by, updated_at, updated_by%s
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
         pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)',
      meta ->> 'table',
      case when pg_catalog.cardinality(column_names) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
      case when pg_catalog.cardinality(column_values) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_values, ', ') end
    );
    execute insert_sql using
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'moduleRootId')::uuid, p_record_type_id,
      (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
      (meta ->> 'moduleReleaseRevision')::bigint,
      owner_account_id, owner_group_id,
      (context_value ->> 'organizationAccountId')::uuid;

    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, record_id_value,
          (relationship_value ->> 'relationshipId')::uuid,
          final_values -> pg_catalog.lower(field_id_value::text), false
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'create', record_id_value, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'access_refused';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    foreach submitted_id in array p_submitted_field_ids loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', 1, 'values', final_values
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

create function vortex_record.change_record_relationship_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_relationship_id uuid,
  p_target_value jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  decision jsonb;
  bounds jsonb;
  field_id_value uuid;
  relationship_value jsonb;
  new_concurrency bigint;
  refusal_reason text := 'relationship_change_refused';
begin
  if p_record_type_id is null or p_record_id is null or p_relationship_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_value is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    select item.value into relationship_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
    where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
    if not found then
      refusal_reason := 'relationship_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(
        bounds -> 'changeableFieldIds'
      ) as allowed(value)
      where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id_value::text)
    ) then
      refusal_reason := 'field_not_changeable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    perform vortex_record.write_relationship_value_internal(
      p_record_type_id, p_record_id, p_relationship_id, p_target_value, true
    );
    execute pg_catalog.format(
      'select concurrency_number from record_data.%I
       where organisation_id = $1 and record_id = $2', meta ->> 'table'
    ) into new_concurrency using
      (meta -> 'context' ->> 'organizationId')::uuid, p_record_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', new_concurrency
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', refusal_reason);
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or check_violation or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
      );
  end;
end
$function$;

-- Recursive worker for one recoverable delete.  It is callable only by its
-- owner and receives no declaration/table input.  The visited identities are
-- defensive cycle protection; published inherited ownership is already
-- required to be acyclic.
create function vortex_record.soft_delete_record_recursive_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  changed_rows integer;
  application_scope uuid;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by #401's fixed loader.
  for incoming in
    select edge.*, mapping.on_parent_delete, mapping.relationship_id,
      mapping.source_field_id
    from vortex_record.relationship_edges as edge
    join vortex_record.relationship_storage_mappings as mapping
      on mapping.relationship_id = edge.relationship_id
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when incoming.on_parent_delete = 'empty_optional' then 'update'
      when incoming.on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = incoming.source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if not found then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if incoming.on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if incoming.on_parent_delete = 'empty_optional' then
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
      );
    elsif incoming.on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  execute pg_catalog.format(
    'update record_data.%I as stored
     set lifecycle_state = ''soft_deleted'',
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       deleted_at = pg_catalog.statement_timestamp(), deleted_by = $3,
       removal_due_at = null, definition_revision = $4
     where organisation_id = $1 and record_id = $2
       and lifecycle_state = ''active'' and concurrency_number = $5',
    meta ->> 'table'
  ) using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record delete revision changed';
  end if;
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'storageContractId')::uuid, application_scope
  );
end
$function$;

create function vortex_record.soft_delete_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    perform vortex_record.soft_delete_record_recursive_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or insufficient_privilege or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
    when check_violation then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
  end;
end
$function$;

create function vortex_record.restore_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  loaded jsonb;
  facts jsonb;
  record_fact jsonb;
  decision jsonb;
  field_item jsonb;
  relationship_value jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  target_catalogue vortex_record.storage_catalogue%rowtype;
  retained_value jsonb;
  retained_target_type_id uuid;
  retained_target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  target_locked boolean;
  changed_rows integer;
  app_scope uuid;
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'restore');
    context_value := meta -> 'context';
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'restore', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    if record_fact ->> 'lifecycleState' <> 'soft_deleted' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- Restore access is decided over the retained row projected as the active
    -- candidate it would become.  The retained values/owner are unchanged.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding',
      'records', (
        select pg_catalog.jsonb_agg(
          case when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
            then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
            else item.value end order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- A restore keeps the retained values. Validate the narrow invariants this
    -- primitive owns: every currently required non-link value is present,
    -- non-null and has its canonical storage shape; every required link agrees
    -- with exactly one retained edge to a locked, active, currently readable
    -- target. Full final-value settings validation remains owned by #47.
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
      where (item.value ->> 'required')::boolean
    loop
      retained_value := record_fact -> 'fieldValues'
        -> pg_catalog.lower(field_item ->> 'fieldId');
      if not ((record_fact -> 'fieldValues') ? pg_catalog.lower(field_item ->> 'fieldId'))
        or pg_catalog.jsonb_typeof(retained_value) = 'null' then
        raise exception using errcode = '23514', message = 'Required retained value is unavailable';
      end if;

      if field_item ->> 'type' not in ('link', 'link_to_one_of_several') then
        if not vortex_record.canonical_record_value_matches(
          retained_value,
          field_item ->> 'type',
          meta -> 'columns' -> pg_catalog.lower(field_item ->> 'fieldId')
            ->> 'databaseValueType'
        ) then
          raise exception using errcode = '23514', message = 'Required retained value is invalid';
        end if;
        continue;
      end if;

      select item.value into strict relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromFieldId')::uuid = (field_item ->> 'fieldId')::uuid;

      -- #402 supports the existing fixed-target to-one relationship contract.
      -- A polymorphic declaration is not inferred here.
      if relationship_value -> 'toRecordType' ->> 'state' <> 'resolved'
        or not (relationship_value -> 'toRecordType' ? 'recordTypeId')
        or pg_catalog.jsonb_typeof(retained_value) <> 'object'
        or not (retained_value ?& array['recordTypeId', 'recordId'])
        or retained_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      begin
        retained_target_type_id := (retained_value ->> 'recordTypeId')::uuid;
        retained_target_record_id := (retained_value ->> 'recordId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end;
      if retained_target_type_id <>
          (relationship_value -> 'toRecordType' ->> 'recordTypeId')::uuid then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      select edge.* into strict edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = (context_value ->> 'organizationId')::uuid
        and edge.from_storage_contract_id = (meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_record_id;
      if edge_row.to_organisation_id <> (context_value ->> 'organizationId')::uuid
        or edge_row.to_record_id <> retained_target_record_id then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select catalogue.* into strict target_catalogue
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = edge_row.to_storage_contract_id
        and catalogue.record_type_id = retained_target_type_id
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active';

      target_locked := false;
      execute pg_catalog.format(
        'select true from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.lifecycle_state = ''active'' for share',
        target_catalogue.physical_table_token
      ) into target_locked using
        (context_value ->> 'organizationId')::uuid, retained_target_record_id;
      if not coalesce(target_locked, false) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      target_loaded := vortex_record.load_record_access_facts_internal(
        retained_target_type_id, 'read', retained_target_record_id, null
      );
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      target_decision := vortex_access.evaluate_organization_record_access_internal(
        target_loaded -> 'declaration', retained_target_record_id, target_loaded -> 'facts'
      );
      if target_decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select item.value into target_record
      from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
      where (item.value -> 'recordScope' ->> 'recordId')::uuid = retained_target_record_id;
      target_scope := target_record -> 'recordScope';
      if target_record is null or target_record ->> 'lifecycleState' <> 'active'
        or (target_scope ->> 'organizationId')::uuid <>
          (context_value ->> 'organizationId')::uuid
        or edge_row.to_application_root_id is distinct from (
          case when target_scope ->> 'storageScope' = 'application_contained'
            then (target_scope ->> 'applicationRootId')::uuid else null end
        ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
    end loop;

    execute pg_catalog.format(
      'update record_data.%I as stored
       set lifecycle_state = ''active'', concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
         deleted_at = null, deleted_by = null, removal_due_at = null,
         definition_revision = $4
       where organisation_id = $1 and record_id = $2
         and lifecycle_state = ''soft_deleted'' and concurrency_number = $5',
      meta ->> 'table'
    ) using (context_value ->> 'organizationId')::uuid, p_record_id,
      (context_value ->> 'organizationAccountId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record restore revision changed';
    end if;
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or too_many_rows or insufficient_privilege or check_violation
      or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end;
end
$function$;

-- All objects below remain owner-only.  #47 will compose them from one fixed
-- protected writer; adding another request grant here would be a second save
-- engine.
revoke all on function vortex_record.resolve_record_action_context_internal(uuid, text),
  vortex_record.bump_record_data_version_internal(uuid, uuid, uuid),
  vortex_record.allocate_reference_number_internal(uuid, uuid, uuid, uuid, jsonb),
  vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean),
  vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid),
  vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb),
  vortex_record.soft_delete_record_recursive_internal(uuid, uuid, bigint, text[]),
  vortex_record.soft_delete_record_internal(uuid, uuid, bigint),
  vortex_record.restore_record_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid) is
  'Private fixed create primitive: derives scope, definition and human ownership, generates references, writes typed values and relationships, and decides create authority over the proposed record in one rollback-safe transaction.';
comment on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb) is
  'Private revision-checked relationship primitive: decides source update and target eligibility, then changes the link value and exact edge atomically.';
comment on function vortex_record.soft_delete_record_internal(uuid, uuid, bigint) is
  'Private revision-checked recoverable delete primitive with current Access and declared incoming relationship handling; it sets no recovery policy.';
comment on function vortex_record.restore_record_internal(uuid, uuid, bigint) is
  'Private revision-checked restore primitive over retained facts, current Access, current definition and required relationships; it enforces no recovery window.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
