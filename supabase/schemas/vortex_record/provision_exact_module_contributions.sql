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
  table_token text;
  column_token text;
  storage_scope_value text;
  scope_index_columns text;
  database_type text;
  sql_type text;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  view_oid oid;
  reader_function_oid oid;
  contribution_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_context.is_non_nil_uuid(p_module_root_id::text)
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
    if not vortex_context.is_non_nil_uuid(contributor_root_id::text)
      or not vortex_context.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_context.is_non_nil_uuid(target_record_type_id::text)
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
      or not vortex_context.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_context.is_non_nil_uuid(target_extension_point_id::text)
      or not vortex_context.is_non_nil_uuid(target_record_type_id::text)
      or not vortex_context.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_context.is_non_nil_uuid(field_id_value::text)
      or not vortex_context.is_non_nil_uuid(contribution_id::text)
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
    if not vortex_context.is_non_nil_uuid(storage_id::text)
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
    select registered.reader_schema, registered.reader_function
    into reader_schema_value, reader_function_value
    from vortex_record.protected_read_model_views as registered
    where registered.protected_read_model_key = protected_view_key;
    if not found then
      raise exception using errcode = '55000',
        message = 'Protected projection view is unavailable';
    end if;
    view_oid := pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', 'record_data', stored_catalogue.physical_table_token
    ))::oid;
    reader_function_oid := pg_catalog.to_regprocedure(pg_catalog.format(
      '%I.%I(uuid,integer)', reader_schema_value, reader_function_value
    ))::oid;
    if view_oid is null
      or reader_function_oid is null
      or not exists (
        select 1
        from pg_catalog.pg_class as relation
        where relation.oid = view_oid
          and relation.relkind = 'v'
          and relation.relowner = 'vortex_record_owner'::regrole
      )
      or exists (
        select 1 from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid = view_oid and not trigger.tgisinternal
      )
      or exists (
        select 1 from pg_catalog.pg_rewrite as rule
        where rule.ev_class = view_oid and rule.rulename <> '_RETURN'
      )
      or not exists (
        select 1
        from pg_catalog.pg_rewrite as rule
        join pg_catalog.pg_depend as dependency
          on dependency.classid = 'pg_rewrite'::regclass
          and dependency.objid = rule.oid
          and dependency.refclassid = 'pg_proc'::regclass
          and dependency.refobjid = reader_function_oid
        where rule.ev_class = view_oid and rule.rulename = '_RETURN'
      )
      or not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = view_oid
          and attribute.attname = 'record_id'
          and attribute.attnum > 0 and not attribute.attisdropped
      )
      or not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = view_oid
          and attribute.attname = 'organisation_id'
          and attribute.attnum > 0 and not attribute.attisdropped
      )
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as field_item(value)
        where not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = view_oid
            and attribute.attname = 'f_' || pg_catalog.replace(
              pg_catalog.lower(field_item.value ->> 'fieldId'), '-', ''
            )
            and attribute.attnum > 0 and not attribute.attisdropped
        )
      )
      or (
        select pg_catalog.count(*)
        from pg_catalog.pg_class as relation
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation.relacl, pg_catalog.acldefault('r', relation.relowner)
        )) as privilege
        where relation.oid = view_oid
          and privilege.grantee = 'vortex_record_adapter'::regrole::oid
          and privilege.privilege_type = 'SELECT'
          and not privilege.is_grantable
      ) <> 1
      or exists (
        select 1
        from pg_catalog.pg_class as relation
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation.relacl, pg_catalog.acldefault('r', relation.relowner)
        )) as privilege
        where relation.oid = view_oid
          and (privilege.grantee not in (
              'vortex_record_owner'::regrole::oid,
              'vortex_record_adapter'::regrole::oid
            )
            or (privilege.grantee = 'vortex_record_adapter'::regrole::oid
              and privilege.privilege_type <> 'SELECT')
            or (privilege.grantee = 'vortex_record_adapter'::regrole::oid
              and privilege.is_grantable))
      )
      or exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = view_oid and attribute.attacl is not null
      ) then
      raise exception using errcode = '55000',
        message = 'Protected projection view lineage is incompatible';
    end if;

    perform vortex_record.create_system_projection_companion_storage_internal(
      storage_id, target_module_root_id, target_record_type_id,
      p_module_root_id, source_field, true
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
      or not vortex_context.is_non_nil_uuid(contribution_id::text)
      or not vortex_context.is_non_nil_uuid(target_extension_point_id::text)
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
    if not vortex_context.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_context.is_non_nil_uuid(field_id_value::text)
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
        target_record_type_id, p_module_root_id, source_field, false
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
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(source_field)
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
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(source_field)
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

alter function vortex_record.provision_exact_module_contributions(uuid,bigint,jsonb) owner to vortex_record_owner;

revoke all on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  to vortex_module_owner;
comment on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb) is
  'Private exact-release contributor storage provisioner: adds generated-table fields or optional unindexed system-projection companion fields and records their retained lineage. It never drops a column, changes projection identity, or overwrites a value.';
