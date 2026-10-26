-- Review of the architecture batch (#3584):
-- * a module's contributed field applies a later definition only after its column is checked and
--   a retired field is active again;
-- * a unique field drops its sort index when it stops being sortable;
-- * an account offboarding transfer has one entry (transfer_offboarding_owned_record), which no
--   longer repeats the access check the record-change operation makes;
-- * invitations of one email to one organisation are serialised, so only one can be pending.
set role vortex_owner;

create or replace function vortex_record.provision_exact_module_contributions(
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_contributions jsonb
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  contribution_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  contribution jsonb;
  contribution_id uuid;
  contribution_kind text;
  contributor_root_id uuid;
  target_module_root_id uuid;
  target_module_version text;
  target_extension_point_id uuid;
  target_record_type_id uuid;
  source_record_type_id uuid;
  field_id_value uuid;
  source_field jsonb;
  storage_id uuid;
  storage_ids uuid[] := array[]::uuid[];
  target_release vortex_definition.releases%rowtype;
  target_content jsonb;
  target_record_type jsonb;
  target_point jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  contributor_revision bigint;
  table_token text;
  column_token text;
  storage_scope_value text;
  scope_index_columns text;
  database_type text;
  sql_type text;
  is_projection boolean;
  protected_view_key text;
  contribution_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  evolve_field boolean;
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_contributions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_contributions) < 1
    or pg_catalog.jsonb_array_length(p_contributions) > 100 then
    raise exception using errcode = '22023',
      message = 'Module contribution storage command is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if release_row.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact contributor Module release is incompatible';
  end if;

  -- Resolve every target record table first, then take its storage lineage lock
  -- in canonical storage-identity order, so a concurrent provisioner and this
  -- helper acquire the same locks in the same order.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if pg_catalog.jsonb_typeof(contribution) is distinct from 'object'
      or pg_catalog.jsonb_typeof(contribution -> 'contributorModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetRecordTypeId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end if;
    begin
      contributor_root_id := (contribution ->> 'contributorModuleRootId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(contributor_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_record_type_id::text)
      or contributor_root_id <> p_module_root_id
      or target_module_root_id = p_module_root_id then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;
    select catalogue.storage_contract_id into storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if storage_id is null then
      raise exception using errcode = '55000',
        message = 'Target record storage is unavailable';
    end if;
    storage_ids := storage_ids || storage_id;
  end loop;

  for storage_id in
    select distinct item.value
    from pg_catalog.unnest(storage_ids) as item(value)
    order by item.value
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
  end loop;

  -- Preflight every projection field in the complete contribution array before
  -- the first generated-table or companion-storage DDL. A later unsupported
  -- projection field therefore cannot follow an earlier physical change.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if contribution ->> 'kind' is distinct from 'field' then
      continue;
    end if;
    begin
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_extension_point_id := (contribution ->> 'targetExtensionPointId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
      source_record_type_id := (contribution ->> 'recordTypeId')::uuid;
      field_id_value := (contribution ->> 'fieldId')::uuid;
      contribution_id := (contribution ->> 'contributionId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    target_module_version := contribution ->> 'targetModuleReleaseVersion';
    if target_module_version is null
      or not vortex_platform.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_extension_point_id::text)
      or not vortex_platform.is_non_nil_uuid(target_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or not vortex_platform.is_non_nil_uuid(contribution_id::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;

    select release.* into strict target_release
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = target_module_root_id
      and release.release_version = target_module_version
      and root.kind = 'module';
    if target_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module')) then
      raise exception using errcode = '23514',
        message = 'Exact target Module release is incompatible';
    end if;
    target_content := target_release.compilation_output #> '{canonical,content}';
    select item.value into target_record_type
    from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId')
      = pg_catalog.lower(target_record_type_id::text);
    if target_record_type is null then
      raise exception using errcode = '23514', message = 'Target record type is unavailable';
    end if;
    is_projection := target_record_type ? 'systemProjection';
    if not is_projection then
      continue;
    end if;

    -- Projection fields are optional and unindexed by contract. Use JSONB
    -- identity comparisons so a missing or non-boolean flag cannot pass.
    select item.value into target_point
    from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as item(value)
    where pg_catalog.lower(item.value ->> 'extensionPointId')
      = pg_catalog.lower(target_extension_point_id::text);
    if target_point is null
      or pg_catalog.lower(target_point ->> 'recordTypeId')
        <> pg_catalog.lower(target_record_type_id::text)
      or not coalesce((target_point -> 'accepts') ? 'field', false) then
      raise exception using errcode = '23514', message = 'Target extension point is unavailable';
    end if;
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
          coalesce(release_row.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
        ) as item(value)
      where pg_catalog.lower(item.value ->> 'contributionId')
          = pg_catalog.lower(contribution ->> 'contributionId')
        and item.value ->> 'kind' = 'field'
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(target_module_root_id::text)
        and pg_catalog.lower(item.value ->> 'targetExtensionPointId')
          = pg_catalog.lower(target_extension_point_id::text)
        and pg_catalog.lower(item.value ->> 'recordTypeId')
          = pg_catalog.lower(source_record_type_id::text)
    ) then
      raise exception using errcode = '23514',
        message = 'Module contribution declaration is unavailable';
    end if;
    source_field := null;
    select item.value into source_field
    from pg_catalog.jsonb_array_elements(
        release_row.compilation_output #> '{canonical,content,recordTypes}'
      ) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as item(value)
    where pg_catalog.lower(record_item.value ->> 'recordTypeId')
        = pg_catalog.lower(source_record_type_id::text)
      and pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text);
    if source_field is null then
      raise exception using errcode = '23514',
        message = 'Contributed field definition is unavailable';
    end if;
    if source_field -> 'required' is distinct from 'false'::jsonb
      or source_field -> 'unique' is distinct from 'false'::jsonb
      or source_field -> 'filterable' is distinct from 'false'::jsonb
      or source_field -> 'sortable' is distinct from 'false'::jsonb then
      raise exception using errcode = '23514',
        message = 'A system projection contribution must be optional and unindexed';
    end if;
    database_type := vortex_record.database_value_type(source_field);
    sql_type := vortex_record.sql_value_type(database_type);
    if database_type is null or sql_type is null then
      raise exception using errcode = '23514',
        message = 'Contributed field type is unsupported';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as item(value)
      where pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text)
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_content -> 'actions') as item(value)
      where pg_catalog.lower(item.value ->> 'actionId')
        = pg_catalog.lower(field_id_value::text)
    ) then
      raise exception using errcode = '55000',
        message = 'Contributed field collides with target storage';
    end if;

    begin
      storage_id := (target_record_type ->> 'storageContractId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '55000',
        message = 'Target record storage lineage is incompatible';
    end;
    protected_view_key := target_record_type #>> '{systemProjection,protectedView}';
    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not (storage_id = any (storage_ids))
      or storage_id <> stored_catalogue.storage_contract_id
      or not exists (
        select 1
        from vortex_record.release_provisions as provision
        where provision.module_root_id = target_release.root_id
          and provision.release_revision = target_release.release_revision
          and storage_id = any (provision.storage_contract_ids)
      )
      or target_record_type ->> 'storageScope' is distinct from 'organization_shared'
      or stored_catalogue.storage_scope is distinct from 'organization_shared'
      or stored_catalogue.physical_schema_token is distinct from 'system_projection'
      or stored_catalogue.physical_table_token is distinct from
        ('rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', ''))
      or stored_catalogue.protected_read_model_key is distinct from protected_view_key
      or protected_view_key is null then
      raise exception using errcode = '55000',
        message = 'Target record storage lineage is incompatible';
    end if;
    perform vortex_record.create_system_projection_companion_storage_internal(
      storage_id, target_module_root_id, target_record_type_id,
      p_module_root_id, p_module_release_revision, source_field, true
    );
  end loop;

  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    begin
      contribution_id := (contribution ->> 'contributionId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_extension_point_id := (contribution ->> 'targetExtensionPointId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    contribution_kind := contribution ->> 'kind';
    target_module_version := contribution ->> 'targetModuleReleaseVersion';
    if contribution_id is null
      or contribution_kind is null
      or target_module_version is null
      or not vortex_platform.is_non_nil_uuid(contribution_id::text)
      or not vortex_platform.is_non_nil_uuid(target_extension_point_id::text)
      or contribution_kind not in ('field', 'action') then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;

    -- The target is the exact dependency release the resolver bound; it must
    -- still declare the accepting extension point on the named record type.
    select release.* into strict target_release
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = target_module_root_id
      and release.release_version = target_module_version
      and root.kind = 'module';
    if target_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module')) then
      raise exception using errcode = '23514',
        message = 'Exact target Module release is incompatible';
    end if;
    target_content := target_release.compilation_output #> '{canonical,content}';
    select item.value into target_record_type
    from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId')
      = pg_catalog.lower(target_record_type_id::text);
    if target_record_type is null then
      raise exception using errcode = '23514', message = 'Target record type is unavailable';
    end if;
    select item.value into target_point
    from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as item(value)
    where pg_catalog.lower(item.value ->> 'extensionPointId')
      = pg_catalog.lower(target_extension_point_id::text);
    if target_point is null
      or pg_catalog.lower(target_point ->> 'recordTypeId')
        <> pg_catalog.lower(target_record_type_id::text)
      or not coalesce((target_point -> 'accepts') ? contribution_kind, false) then
      raise exception using errcode = '23514',
        message = 'Target extension point is unavailable';
    end if;

    -- The contributor's own exact release must declare this contribution to this
    -- target Module's extension point; a caller cannot attach an undeclared field
    -- or action.
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
          coalesce(release_row.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
        ) as item(value)
      where pg_catalog.lower(item.value ->> 'contributionId')
          = pg_catalog.lower(contribution_id::text)
        and item.value ->> 'kind' = contribution_kind
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(target_module_root_id::text)
        and pg_catalog.lower(item.value ->> 'targetExtensionPointId')
          = pg_catalog.lower(target_extension_point_id::text)
        and (contribution_kind <> 'field'
          or pg_catalog.lower(item.value ->> 'recordTypeId')
            = pg_catalog.lower(contribution ->> 'recordTypeId'))
    ) then
      raise exception using errcode = '23514',
        message = 'Module contribution declaration is unavailable';
    end if;

    if contribution_kind = 'action' then
      -- An action contribution has no physical storage; the exact resolved
      -- binding already carries the capability, so only its identity is echoed.
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements(release_row.compilation_output #> '{canonical,content,actions}') as item(value)
        where pg_catalog.lower(item.value ->> 'actionId') = pg_catalog.lower(contribution_id::text)
      ) then
        raise exception using errcode = '23514',
          message = 'Contributed action definition is unavailable';
      end if;
      contribution_ids := contribution_ids || contribution_id;
      continue;
    end if;

    -- A field contribution reuses the contributor's exact field definition and
    -- adds its permanent value storage to the target's generated table or projection companion.
    begin
      source_record_type_id := (contribution ->> 'recordTypeId')::uuid;
      field_id_value := (contribution ->> 'fieldId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;
    source_field := null;
    select item.value into source_field
    from pg_catalog.jsonb_array_elements(
        release_row.compilation_output #> '{canonical,content,recordTypes}'
      ) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as item(value)
    where pg_catalog.lower(record_item.value ->> 'recordTypeId')
        = pg_catalog.lower(source_record_type_id::text)
      and pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text);
    if source_field is null then
      raise exception using errcode = '23514',
        message = 'Contributed field definition is unavailable';
    end if;

    -- The contributed identity may not collide with the target's own component.
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as item(value)
      where pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text)
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_content -> 'actions') as item(value)
      where pg_catalog.lower(item.value ->> 'actionId')
        = pg_catalog.lower(field_id_value::text)
    ) then
      raise exception using errcode = '55000',
        message = 'Contributed field collides with target storage';
    end if;

    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    table_token := stored_catalogue.physical_table_token;
    storage_scope_value := stored_catalogue.storage_scope;
    scope_index_columns := vortex_record.index_scope_columns(storage_scope_value);
    is_projection := target_record_type ? 'systemProjection';
    column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
    database_type := vortex_record.database_value_type(source_field);
    sql_type := vortex_record.sql_value_type(database_type);
    if database_type is null or sql_type is null then
      raise exception using errcode = '23514', message = 'Contributed field type is unsupported';
    end if;

    evolve_field := false;
    select mapping.* into stored_field
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = stored_catalogue.storage_contract_id
      and mapping.field_id = field_id_value
    for update;
    if found then
      select pg_catalog.max(provision.release_revision) into contributor_revision
      from vortex_record.release_provisions as provision
      where provision.module_root_id = p_module_root_id;
      if stored_field.physical_column_token <> column_token
        or stored_field.database_value_type <> database_type
        or stored_field.introduced_by_module_root_id <> p_module_root_id
        or not vortex_record.field_storage_compatible(
          stored_field.field_definition, source_field,
          p_module_release_revision < contributor_revision
        )
        or stored_field.state not in ('active', 'retired') then
        raise exception using errcode = '55000',
          message = 'Existing contributed field storage is incompatible';
      end if;
      -- A later definition is applied once the column is checked and a retired field is active.
      evolve_field := p_module_release_revision >= contributor_revision
        and stored_field.field_definition is distinct from source_field;
    end if;

    if is_projection then
      begin
        storage_id := (target_record_type ->> 'storageContractId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '55000',
          message = 'Target record storage lineage is incompatible';
      end;
      if storage_id is distinct from stored_catalogue.storage_contract_id
        or stored_catalogue.storage_scope is distinct from 'organization_shared'
        or stored_catalogue.physical_schema_token is distinct from 'system_projection'
        or stored_catalogue.physical_table_token is distinct from
          ('rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', ''))
        or stored_catalogue.protected_read_model_key is distinct from
          (target_record_type #>> '{systemProjection,protectedView}') then
        raise exception using errcode = '55000',
          message = 'Target record storage lineage is incompatible';
      end if;
      perform vortex_record.create_system_projection_companion_storage_internal(
        stored_catalogue.storage_contract_id, target_module_root_id,
        target_record_type_id, p_module_root_id, p_module_release_revision, source_field, false
      );
      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = stored_catalogue.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.introduced_by_module_root_id <> p_module_root_id
          or stored_field.state not in ('active', 'retired') then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        if stored_field.state = 'retired' then
          update vortex_record.field_storage_mappings as mapping
          set state = 'active',
              retired_by_module_root_id = null,
              retired_at_release_revision = null
          where mapping.storage_contract_id = stored_catalogue.storage_contract_id
            and mapping.field_id = field_id_value;
          any_change := true;
        end if;
      else
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          stored_catalogue.storage_contract_id, field_id_value, column_token, database_type,
          source_field, p_module_root_id, p_module_release_revision, 'active'
        );
        any_change := true;
      end if;
    else
      if stored_catalogue.physical_schema_token <> 'record_data'
        or scope_index_columns is null then
        raise exception using errcode = '55000', message = 'Target record storage is incompatible';
      end if;

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = stored_catalogue.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.introduced_by_module_root_id <> p_module_root_id
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        if stored_field.state = 'retired' then
          update vortex_record.field_storage_mappings as mapping
          set state = 'active',
              retired_by_module_root_id = null,
              retired_at_release_revision = null
          where mapping.storage_contract_id = stored_catalogue.storage_contract_id
            and mapping.field_id = field_id_value;
          any_change := true;
        elsif stored_field.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
      else
        if (source_field ->> 'required')::boolean then
          raise exception using errcode = '55000',
            message = 'A new contributed field must be optional on shared storage';
        end if;
        -- A column without a mapping has unknown meaning and values, so it is
        -- never adopted.
        if exists (
          select 1
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = pg_catalog.to_regclass(
              pg_catalog.format('%I.%I', 'record_data', table_token)
            )
            and attribute.attname = column_token
            and attribute.attnum > 0
            and not attribute.attisdropped
        ) then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s',
          table_token, column_token, sql_type
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          stored_catalogue.storage_contract_id, field_id_value, column_token, database_type,
          source_field, p_module_root_id, p_module_release_revision, 'active'
        );
        if (source_field ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            stored_catalogue.storage_contract_id, field_id_value, 'uniqueness',
            storage_scope_value, table_token, scope_index_columns, column_token
          );
        elsif (source_field ->> 'filterable')::boolean
          or (source_field ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            stored_catalogue.storage_contract_id, field_id_value, 'performance',
            storage_scope_value, table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end if;
    if evolve_field then
      perform vortex_record.evolve_field_storage_internal(
        stored_catalogue.storage_contract_id, field_id_value, source_field,
        storage_scope_value, table_token, column_token, is_projection
      );
      any_change := true;
    end if;

    contribution_ids := contribution_ids || contribution_id;
  end loop;

  return query select p_module_root_id, p_module_release_revision, contribution_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module contribution evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module contribution evidence is ambiguous';
end
$function$;

create or replace function vortex_record.evolve_field_storage_internal(
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_requested jsonb,
  p_storage_scope text,
  p_table_token text,
  p_column_token text,
  p_is_projection boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored vortex_record.field_storage_mappings%rowtype;
  scope_columns text := vortex_record.index_scope_columns(p_storage_scope);
  desired_purpose text;
  current_purpose text;
begin
  select mapping.* into strict stored
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id and mapping.field_id = p_field_id
  for update;
  if not vortex_record.field_storage_compatible(stored.field_definition, p_requested, false) then
    raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
  end if;
  if stored.field_definition is not distinct from p_requested then
    return;
  end if;
  if not p_is_projection then
    -- A later release may stop requiring a value.
    if coalesce((stored.field_definition ->> 'required')::boolean, false)
      and not coalesce((p_requested ->> 'required')::boolean, false) then
      execute pg_catalog.format(
        'alter table record_data.%I alter column %I drop not null', p_table_token, p_column_token
      );
    end if;
    -- The field's one index follows its current flags: uniqueness, else performance when the
    -- field can be filtered or sorted, else none.
    desired_purpose := case
      when coalesce((p_requested ->> 'unique')::boolean, false) then 'uniqueness'
      when coalesce((p_requested ->> 'filterable')::boolean, false)
        or coalesce((p_requested ->> 'sortable')::boolean, false) then 'performance'
      else null end;
    select index_row.purpose into current_purpose
    from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = p_storage_contract_id
      and index_row.field_id = p_field_id
      and index_row.purpose in ('uniqueness', 'performance');
    if current_purpose is distinct from desired_purpose then
      if current_purpose is not null then
        execute pg_catalog.format('drop index if exists record_data.%I',
          'ux_' || pg_catalog.substr(p_column_token, 3));
        execute pg_catalog.format('drop index if exists record_data.%I',
          'ix_' || pg_catalog.substr(p_column_token, 3));
        delete from vortex_record.index_catalogue as index_row
        where index_row.storage_contract_id = p_storage_contract_id
          and index_row.field_id = p_field_id
          and index_row.purpose in ('uniqueness', 'performance');
      end if;
    end if;
    -- A unique field keeps its sort index only while it is sortable.
    if desired_purpose = 'uniqueness'
      and not coalesce((p_requested ->> 'sortable')::boolean, false) then
      execute pg_catalog.format('drop index if exists record_data.%I',
        'ix_' || pg_catalog.substr(p_column_token, 3));
    end if;
  end if;
  update vortex_record.field_storage_mappings as mapping
  set field_definition = p_requested
  where mapping.storage_contract_id = p_storage_contract_id and mapping.field_id = p_field_id;
  if not p_is_projection and desired_purpose is not null then
    perform vortex_record.ensure_field_index_internal(
      p_storage_contract_id, p_field_id, desired_purpose, p_storage_scope,
      p_table_token, scope_columns, p_column_token
    );
  end if;
end
$function$;

comment on function vortex_record.evolve_field_storage_internal(uuid, uuid, jsonb, text, text, text, boolean) is
  'Applies a later compatible release of one stored field: drops a requirement it no longer has, moves the field to the one index its unique, filterable and sortable flags need (a unique field''s sort index only while sortable), and records the release''s field definition.';

create or replace function vortex_identity.create_organization_invitation(
  p_invited_email text,
  p_expires_at timestamptz
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  invited_email text,
  invited_by uuid,
  created_at timestamptz,
  invited_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  accepted_at timestamptz,
  accepted_organization_account_id uuid,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  new_invitation_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();
  if p_invited_email is null
    or p_invited_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Invitation input is invalid';
  end if;

  -- One pending invitation per email and organisation: inviting again while one waits is refused.
  -- Invitations of one email to one organisation are serialised, so two at once cannot both pass.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      checked ->> 'organizationId', p_invited_email), 3584)
  );
  if exists (
    select 1
    from vortex_identity.organization_invitations as pending
    where pending.organization_id = (checked ->> 'organizationId')::uuid
      and pending.invited_email = p_invited_email
      and pending.accepted_at is null
      and pending.revoked_at is null
      and pending.expires_at > operation_at
  ) then
    raise exception using errcode = '23505', message = 'Invitation is already pending';
  end if;

  loop
    new_invitation_id := pg_catalog.gen_random_uuid();
    exit when new_invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, invited_by_organization_account_id,
    created_at, invited_at, expires_at, changed_at, revision
  ) values (
    new_invitation_id, (checked ->> 'organizationId')::uuid, p_invited_email,
    (checked ->> 'organizationAccountId')::uuid,
    operation_at, operation_at, p_expires_at, operation_at, 1
  );

  return query
  select invitation.invitation_id, invitation.organization_id, invitation.invited_email,
    invitation.invited_by_organization_account_id, invitation.created_at,
    invitation.invited_at, invitation.expires_at, invitation.revoked_at,
    invitation.revoked_by_organization_account_id, invitation.accepted_at,
    invitation.accepted_organization_account_id, invitation.changed_at,
    invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.invitation_id = new_invitation_id;
end
$function$;

reset role;

set role vortex_record_adapter;

create or replace function vortex_record.apply_lifecycle_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  correlation_id_value uuid;
begin
  -- Closed lifecycle entry to apply_record_changes. Delete alone accepts null
  -- mutations to begin its traversal; the second call supplies calculated parent
  -- mutations and finalises the same command in the same request transaction. An account
  -- offboarding transfer enters only through transfer_offboarding_owned_record.
  if p_operation is null
    or p_operation not in ('delete', 'restore', 'transfer_ownership')
    or (pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      and not (p_operation = 'delete' and p_mutations is null))
    or coalesce(pg_catalog.jsonb_path_exists(
      p_mutations, '$[*] ? (@.kind == "offboarding_transfer")'
    ), false) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  result_value := vortex_record.apply_record_changes(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, '{}'::jsonb, null,
    p_mutations, p_activity_id, p_occurrence_id
  );
  if p_operation <> 'transfer_ownership' then
    return result_value;
  end if;

  if result_value ->> 'outcome' = 'saved' then
    return result_value - array['values', 'backgroundDelivery']::text[]
      || pg_catalog.jsonb_build_object('outcome', 'transferred');
  end if;
  if result_value ->> 'outcome' in ('conflict', 'refused') then
    correlation_id_value :=
      (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
    return result_value || pg_catalog.jsonb_build_object('correlationId', correlation_id_value);
  end if;
  return result_value;
end
$function$;

comment on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The request role''s closed entry to delete preparation and finalisation, restore and ownership-transfer record-change writes: it refuses any other operation and an account offboarding transfer, and delegates once to the one protected apply_record_changes operation.';

-- The protected entry revokes EXECUTE from its owner. Restore it only long enough for
-- CREATE OR REPLACE.
grant execute on function vortex_record.transfer_offboarding_owned_record(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid, bigint) to vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  -- The one record-change operation checks the accounts.manage scope and its access version,
  -- reloads the record facts, locks the target and requires the caller's expected concurrency
  -- number before it mutates anything.
  begin
    return vortex_record.apply_record_changes(
      p_command_id, 'transfer_ownership', p_record_type_id, p_record_id,
      p_expected_concurrency_number, '{}'::jsonb, null,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'offboarding_transfer',
        'targetKind', p_target_kind,
        'targetId', p_target_id,
        'sourceOrganizationAccountId', p_source_organization_account_id,
        'expectedAccessVersion', p_expected_access_version
      )),
      p_activity_id, p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- A contested final update is an expected per-record result. The nested
      -- exception block rolls back its pending receipt before returning it.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$$;

COMMENT ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) IS 'The one protected request entry for a disclosed account-offboarding transfer of a retained or disabled-installation record; the record-change operation checks the accounts.manage scope, access version, target, owner, lifecycle and revision.';

revoke all on function vortex_record.transfer_offboarding_owned_record(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid, bigint) from vortex_record_adapter;

reset role;
