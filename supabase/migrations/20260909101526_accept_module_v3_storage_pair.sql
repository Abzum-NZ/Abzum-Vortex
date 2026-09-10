-- Accept exact immutable Module V2 and V3 releases for Record storage.
-- Module V3 adds rule graphs to Module V2 content without changing its
-- field/storage model, so the physical generator contract stays 1.0.0 and
-- still excludes rules. The function is replaced under its existing owner:
-- signature, volatility, security mode, empty search path, grants and ACL
-- are unchanged, and no other object is touched.

set local role vortex_record_owner;

create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_check text;
  owner_check text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version not in ('2.0.0', '3.0.0')
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
  if pg_catalog.jsonb_typeof(record_types) <> 'array'
    or pg_catalog.jsonb_array_length(record_types) < 1 then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision
      and provision.content_fingerprint = release_row.content_fingerprint
      and provision.resolution_fingerprint = release_row.resolution_fingerprint
      and provision.generator_contract_version = '1.0.0';
    if result_storage_ids is null then
      raise exception using errcode = '55000', message = 'Stored release provision evidence is incompatible';
    end if;
    if result_storage_ids is distinct from (
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
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
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      scope_check := case storage_scope_value
        when 'organization_shared' then 'application_root_id is null'
        else 'application_root_id is not null'
      end;
      owner_check := case ownership_mode_value
        when 'organization_account' then
          'owner_organisation_account_id is not null and owner_group_id is null'
        when 'group' then
          'owner_organisation_account_id is null and owner_group_id is not null'
        else 'owner_organisation_account_id is null and owner_group_id is null'
      end;
      execute pg_catalog.format(
        'create table record_data.%I (
          organisation_id uuid not null references vortex_identity.organizations (organization_id),
          module_root_id uuid not null check (module_root_id = %L::uuid),
          record_type_id uuid not null check (record_type_id = %L::uuid),
          storage_contract_id uuid not null check (storage_contract_id = %L::uuid),
          record_id uuid not null,
          application_root_id uuid,
          definition_revision bigint not null check (definition_revision between 1 and 9007199254740991),
          owner_organisation_account_id uuid,
          owner_group_id uuid,
          lifecycle_state text not null check (lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')),
          concurrency_number bigint not null check (concurrency_number between 1 and 9007199254740991),
          created_at timestamptz not null,
          created_by uuid not null,
          updated_at timestamptz not null,
          updated_by uuid not null,
          deleted_at timestamptz,
          deleted_by uuid,
          removal_due_at timestamptz,
          primary key (%s, record_id),
          foreign key (organisation_id, owner_organisation_account_id)
            references vortex_identity.organization_accounts (organization_id, organization_account_id),
          foreign key (organisation_id, owner_group_id)
            references vortex_access.organization_groups (organization_id, group_id),
          check (%s), check (%s),
          check ((deleted_at is null) = (deleted_by is null)),
          check ((lifecycle_state = ''active'') = (deleted_at is null and deleted_by is null)),
          check (updated_at >= created_at)
        )', table_token, p_module_root_id, record_type_id_value, storage_id,
        scope_index_columns, scope_check, owner_check
      );
      execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
      execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
      execute pg_catalog.format(
        'create policy record_select on record_data.%I for select to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_insert on record_data.%I for insert to vortex_record_adapter with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_update on record_data.%I for update to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        ) with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_delete on record_data.%I for delete to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'grant select, insert, update, delete on record_data.%I to vortex_record_adapter',
        table_token
      );

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, generator_contract_version, content_fingerprint, record_type_definition
      ) values (
        storage_id, 'record_data', table_token, p_module_root_id,
        record_type_id_value, storage_scope_value, p_module_release_revision,
        p_module_release_revision, 'active', '1.0.0', shape_fingerprint, record_type
      );
      any_change := true;
    else
      if stored_catalogue.module_root_id <> p_module_root_id
        or stored_catalogue.record_type_id <> record_type_id_value
        or stored_catalogue.storage_scope <> storage_scope_value
        or stored_catalogue.state <> 'active'
        or stored_catalogue.generator_contract_version <> '1.0.0'
        or stored_catalogue.physical_schema_token <> 'record_data'
        or stored_catalogue.physical_table_token <> table_token
        or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
        raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
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

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
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
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if stored_catalogue.storage_contract_id is not null
          and (field_value ->> 'required')::boolean then
          raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s%s',
          table_token, column_token, sql_type,
          case when (field_value ->> 'required')::boolean then ' not null' else '' end
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        if (field_value ->> 'unique')::boolean then
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            'ux_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          execute pg_catalog.format(
            'create index %I on record_data.%I (%s, %I)',
            'ix_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  select pg_catalog.array_agg(value order by value) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, content_fingerprint, resolution_fingerprint,
    generator_contract_version, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, release_row.content_fingerprint,
    release_row.resolution_fingerprint, '1.0.0', result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    release_row.content_fingerprint, release_row.resolution_fingerprint,
    '1.0.0'::text, result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

reset role;
