-- A Module may hold no record types yet: a new Application starts with one empty owned Module.
-- Its release is provisioned with no storage, its installation binds no storage, and an
-- installation without record types has no index, lifecycle-policy or setup targets.
set local role vortex_owner;

alter table vortex_record.release_provisions
  drop constraint release_provisions_storage_contract_ids_check;
alter table vortex_definition.installation_bindings
  drop constraint installation_bindings_storage_contract_ids_check;
create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
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
  projection_expression_pair record;
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
  stored_projection_role text;
  requested_projection_role text;
  stored_database_type text;
  requested_database_type text;
  stored_sql_type text;
  requested_sql_type text;
  stored_expression jsonb;
  requested_expression jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  field_columns_sql text;
  projection_view_sql text;
  existing_columns text[];
  expected_columns text[];
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
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
  -- A Module may hold no record types yet; its release is provisioned with no storage.
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
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
      and provision.release_revision = p_module_release_revision;
    if result_storage_ids is distinct from coalesce((
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ), array[]::uuid[]) then
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
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The eight-sortable-field limit is a publish rule; an older release may declare more and
    -- simply gets an index per sortable field.
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

    -- A system projection record type has no generated storage. It is read
    -- through one registered protected view, created here as an ordinary
    -- record_data relation so the fixed read adapters resolve it unchanged,
    -- while the projection itself keeps every row-visibility rule inside the
    -- registered function. The view exposes exactly the record type's declared
    -- fields as record-data columns, plus the protected row identity and
    -- revision, and is read-only: the projection has no ordinary write path.
    -- Every projection value is reset per record type, so a generated record
    -- type provisioned after a projection never inherits its protected key.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    reader_schema_value := null;
    reader_function_value := null;
    projection_view_sql := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      select registered.reader_schema, registered.reader_function
      into reader_schema_value, reader_function_value
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501',
          message = 'Protected projection view is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
      field_columns_sql := '';
      expected_columns := array[]::text[];
      for field_value in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
        order by item.value ->> 'fieldId'
      loop
        begin
          field_id_value := (field_value ->> 'fieldId')::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '42501',
            message = 'Record field storage identity is invalid';
        end;
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        database_type := vortex_record.database_value_type(field_value);
        if database_type is null then
          raise exception using errcode = '23514',
            message = 'Record field storage type is unsupported';
        end if;
        sql_type := vortex_record.sql_value_type(database_type);
        expected_columns := expected_columns || column_token;
        if field_value ->> 'fieldId' = record_type #>> '{systemProjection,organizationFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.organization_id::text as %I, ', column_token);
        elsif field_value ->> 'fieldId' = record_type #>> '{systemProjection,revisionFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.revision::%s as %I, ', sql_type, column_token);
        elsif database_type = 'json' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values -> %L) as %I, ', field_value ->> 'key', column_token
            );
        else
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values ->> %L)::%s as %I, ',
              field_value ->> 'key', sql_type, column_token
            );
        end if;
      end loop;
      select pg_catalog.array_agg(item.column_name order by item.column_name)
      into expected_columns
      from pg_catalog.unnest(expected_columns) as item(column_name);
      field_columns_sql := pg_catalog.left(
        field_columns_sql, pg_catalog.length(field_columns_sql) - 2
      );
      projection_view_sql := pg_catalog.format(
        'create view record_data.%I as select
           projection.organization_id as organisation_id,
           %L::uuid as module_root_id,
           %L::uuid as record_type_id,
           %L::uuid as storage_contract_id,
           projection.record_id,
           null::uuid as application_root_id,
           %L::bigint as definition_revision,
           null::uuid as owner_organisation_account_id,
           null::uuid as owner_group_id,
           ''active''::text as lifecycle_state,
           projection.revision as concurrency_number,
           null::timestamptz as created_at,
           null::uuid as created_by,
           null::timestamptz as updated_at,
           null::uuid as updated_by,
           null::timestamptz as deleted_at,
           null::uuid as deleted_by,
           null::timestamptz as removal_due_at,
           %s
         from %I.%I(null::uuid, null::integer) as projection',
        table_token, p_module_root_id, record_type_id_value, storage_id,
        p_module_release_revision, field_columns_sql,
        reader_schema_value, reader_function_value
      );
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if is_projection then
        execute projection_view_sql;
        execute pg_catalog.format(
          'grant select on record_data.%I to vortex_record_adapter', table_token
        );
      else
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value
        );
      end if;

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, content_fingerprint, record_type_definition, protected_read_model_key
      ) values (
        storage_id,
        case when is_projection then 'system_projection' else 'record_data' end,
        table_token, p_module_root_id, record_type_id_value, storage_scope_value,
        p_module_release_revision, p_module_release_revision, 'active',
        shape_fingerprint, record_type, protected_view_key
      );
      any_change := true;
    else
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
        if pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition) is distinct from 'object'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'fields') is distinct from 'array'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'systemProjection') is distinct from 'object'
          or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object' then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;

        -- The catalogue keeps the newest compatible exact definition. Compare
        -- only shared field identities so an older subset and newer additions
        -- retain their existing release-order behavior. These descriptors
        -- mirror the source expressions assembled above, including the
        -- protected attribute key, JSON/text extraction, and cast.
        for projection_expression_pair in
          select requested_item.value as requested_field,
            stored_item.value as stored_field
          from pg_catalog.jsonb_array_elements(record_type -> 'fields') as requested_item(value)
          join pg_catalog.jsonb_array_elements(
            stored_catalogue.record_type_definition -> 'fields'
          ) as stored_item(value)
            on stored_item.value ->> 'fieldId' = requested_item.value ->> 'fieldId'
          order by requested_item.value ->> 'fieldId'
        loop
          stored_projection_role := case
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          requested_projection_role := case
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          stored_database_type := vortex_record.database_value_type(
            projection_expression_pair.stored_field
          );
          requested_database_type := vortex_record.database_value_type(
            projection_expression_pair.requested_field
          );
          if stored_projection_role is distinct from requested_projection_role
            or stored_database_type is null
            or requested_database_type is null then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
          stored_sql_type := vortex_record.sql_value_type(stored_database_type);
          requested_sql_type := vortex_record.sql_value_type(requested_database_type);
          stored_expression := case stored_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.revision',
              'cast', stored_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.stored_field ->> 'key',
              'extraction', case when stored_database_type = 'json' then '->' else '->>' end,
              'cast', case when stored_database_type = 'json' then null else stored_sql_type end
            )
          end;
          requested_expression := case requested_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.revision',
              'cast', requested_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.requested_field ->> 'key',
              'extraction', case when requested_database_type = 'json' then '->' else '->>' end,
              'cast', case when requested_database_type = 'json' then null else requested_sql_type end
            )
          end;
          if stored_expression is distinct from requested_expression then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
        end loop;

        select coalesce(
            pg_catalog.array_agg(attribute.attname order by attribute.attname),
            array[]::text[]
          )
        into existing_columns
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('%I.%I', 'record_data', table_token)
          )
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attname like 'f\_%';
        -- The view always carries the newest compatible release's shape, as a
        -- generated table keeps every column a newer release added. A newer
        -- release, or the newest one with a different field set, recreates it
        -- exactly; an older release, which the field checks below prove is a
        -- compatible subset, leaves the newer view alone. The projection has no
        -- indexes or dependent objects.
        if p_module_release_revision > stored_catalogue.last_compatible_release_revision
          or (p_module_release_revision = stored_catalogue.last_compatible_release_revision
            and existing_columns is distinct from expected_columns) then
          execute pg_catalog.format('drop view record_data.%I', table_token);
          execute projection_view_sql;
          execute pg_catalog.format(
            'grant select on record_data.%I to vortex_record_adapter', table_token
          );
          any_change := true;
        end if;
      else
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'record_data'
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
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
        if not is_projection then
          if stored_catalogue.storage_contract_id is not null
            and (field_value ->> 'required')::boolean then
            raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
          end if;
          execute pg_catalog.format(
            'alter table record_data.%I add column %I %s%s',
            table_token, column_token, sql_type,
            case when (field_value ->> 'required')::boolean then ' not null' else '' end
          );
        end if;
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        -- A projection field lives in the protected view, which carries no
        -- indexes; the projection's own protected function applies visibility,
        -- ordering and filtering, so no generated index is provisioned.
        if is_projection then
          null;
        elsif (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    -- Only a field this Module itself introduced can prove a removed field. A
    -- field another Module contributed keeps its retained lineage and never
    -- refuses this Module's own storage.
    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_by_module_root_id = p_module_root_id
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

  -- The release declares each legacy Person field paired with its new link.
  -- Both field columns and relationship mappings now exist for every record type.
  perform vortex_record.backfill_person_links_internal(
    p_module_root_id, p_module_release_revision
  );

  select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[]) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_storage(uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves the generated record_data storage, or the read-only record_data view over one registered protected projection reader for a system projection record type, for one published Module release and records its immutable provision evidence.';

CREATE OR REPLACE FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_id uuid;
  catalogue_purpose text;
  catalogue_token text;
  catalogue_fingerprint text;
  catalogue_observed text;
  catalogue_revision bigint;
  ready boolean;
  target_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index readiness command is invalid';
  end if;

  -- The same protected activation target fact the lifecycle-policy readiness
  -- read uses; the organisation is re-derived from the validated human request
  -- context inside it and is never taken from the caller.
  -- An installation whose Modules hold no record types yet has no targets and no indexes.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    for mapping in
      select stored.field_id, stored.physical_column_token, stored.field_definition
      from vortex_record.field_storage_mappings as stored
      where stored.storage_contract_id = target.storage_contract_id
        and stored.state = 'active'
        and (
          coalesce((stored.field_definition ->> 'unique')::boolean, false)
          or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
          or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
        )
      order by stored.field_id
    loop
      purpose := case
        when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
          then 'uniqueness'
        else 'performance'
      end;
      scope_columns := vortex_record.index_scope_columns(target.storage_scope);
      index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping.physical_column_token, 3);
      definition_fingerprint := vortex_record.index_definition_fingerprint(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );
      observed := vortex_record.observe_field_index_internal(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );

      select stored_index.index_contract_id, stored_index.purpose,
        stored_index.physical_index_token, stored_index.desired_definition_fingerprint,
        stored_index.observed_state, stored_index.observed_revision
      into catalogue_id, catalogue_purpose, catalogue_token, catalogue_fingerprint,
        catalogue_observed, catalogue_revision
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
        and stored_index.purpose in ('uniqueness', 'performance')
      for share;

      ready := observed = 'present'
        and catalogue_id is not null
        and catalogue_purpose = purpose
        and catalogue_token = index_token
        and catalogue_fingerprint = definition_fingerprint;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'observedState', observed,
        'recordedObservedState', catalogue_observed,
        'observedRevision', catalogue_revision,
        'ready', ready
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never an
  -- implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$$;
alter function vortex_record.read_index_readiness(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Live readiness of every exact field index an activating Application installation owns: uniqueness indexes are activation requirements, performance indexes are advisory.';

REVOKE ALL ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;

CREATE OR REPLACE FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target record;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  target_storage_contract_ids uuid[];
  target_count integer := 0;
  policies jsonb := '[]'::jsonb;
  workflows jsonb := '[]'::jsonb;
  connections jsonb := '[]'::jsonb;
  connection_readiness jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Lifecycle activation readiness command is invalid';
  end if;

  -- One read of the installation targets, de-duplicated once, so the
  -- completeness check below cannot disagree with the policies collected.
  -- An installation whose Modules hold no record types yet has no targets and no policies.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    select stored.* into policy_row
    from vortex_record.record_type_lifecycle_policies as stored
    where stored.organization_id = p_organization_id
      and stored.storage_contract_id = target.storage_contract_id
      and stored.application_root_id is not distinct from case
        when target.storage_scope = 'application_contained' then p_application_root_id
        else null
      end
    for share;
    if not found then
      raise exception using errcode = '23514',
        message = 'Record-type lifecycle policy is unavailable';
    end if;
    policies := policies || pg_catalog.jsonb_build_array(policy_row.policy_body);

    if policy_row.action = 'archive_workflow' then
      -- An archive policy always carries a permanent Application scope; #566
      -- refuses to store an organisation-shared one.
      if policy_row.application_root_id is distinct from p_application_root_id then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive policy scope is unavailable';
      end if;

      if not vortex_definition.record_lifecycle_workflow_is_installed_internal(
        p_organization_id,
        p_application_root_id,
        target.storage_contract_id,
        (policy_row.policy_body ->> 'archiveWorkflowId')::uuid,
        (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint
      ) then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive workflow is unavailable';
      end if;

      connection_readiness := vortex_platform.resolve_connection_instance_readiness(
        p_organization_id,
        p_application_root_id,
        (policy_row.policy_body ->> 'archiveConnectionInstanceId')::uuid,
        policy_row.policy_body ->> 'archiveDestination',
        (policy_row.policy_body #>> '{expectedConnectionRevision}')::bigint,
        policy_row.policy_body ->> 'expectedDestinationFingerprint'
      );
      -- Every returned fact is checked against the stored policy, exactly as
      -- the #566 save does: a 'ready' outcome alone is not evidence that the
      -- readiness answers the policy this activation is gating on.
      if connection_readiness ->> 'outcome' is distinct from 'ready'
        or pg_catalog.lower(connection_readiness ->> 'connectionInstanceId')
          is distinct from pg_catalog.lower(
            policy_row.policy_body ->> 'archiveConnectionInstanceId')
        or connection_readiness ->> 'organizationId' is distinct from p_organization_id::text
        or connection_readiness ->> 'applicationRootId'
          is distinct from p_application_root_id::text
        or connection_readiness ->> 'destinationKey'
          is distinct from policy_row.policy_body ->> 'archiveDestination'
        or connection_readiness ->> 'destinationFingerprint'
          is distinct from policy_row.policy_body ->> 'expectedDestinationFingerprint'
        or connection_readiness ->> 'revision'
          is distinct from policy_row.policy_body #>> '{expectedConnectionRevision}'
        or connection_readiness ->> 'healthOutcome' is distinct from 'healthy'
        or connection_readiness ->> 'state' is distinct from 'active' then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive connection is unavailable';
      end if;

      workflows := workflows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'workflowId', policy_row.policy_body ->> 'archiveWorkflowId',
        'workflowRevision',
          (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint,
        'organizationId', p_organization_id,
        'authorizedApplicationIds', pg_catalog.jsonb_build_array(p_application_root_id),
        'state', 'active'
      ));
      connections := connections || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'connectionInstanceId', connection_readiness ->> 'connectionInstanceId',
        'destinationKey', connection_readiness ->> 'destinationKey',
        'destinationFingerprint', connection_readiness ->> 'destinationFingerprint',
        'organizationId', p_organization_id,
        'authorizedApplicationIds', pg_catalog.jsonb_build_array(p_application_root_id),
        'state', connection_readiness ->> 'state',
        'revision', (connection_readiness ->> 'revision')::bigint,
        'lastHealthOutcome', connection_readiness ->> 'healthOutcome',
        'verifiedAt', connection_readiness -> 'verifiedAt'
      ));
    end if;
  end loop;

  -- Every installed storage contract must be an active catalogue entry with a
  -- policy. A target this read cannot account for is an incomplete
  -- installation, never an implicitly unmanaged record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Lifecycle activation targets are incomplete';
  end if;

  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = p_organization_id
  for share;
  if not found then
    raise exception using errcode = '23514',
      message = 'Organisation lifecycle limits are unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'policies', policies,
    'organizationLimits', pg_catalog.jsonb_build_object(
      'organizationId', limits_row.organization_id,
      'settingsRevision', limits_row.settings_revision,
      'maxRetentionDays', limits_row.max_retention_days,
      'maxRecordCount', limits_row.max_record_count,
      'allowUnlimitedRetentionDays', limits_row.allow_unlimited_retention_days,
      'allowUnlimitedRecordCount', limits_row.allow_unlimited_record_count,
      'allowedActions', pg_catalog.to_jsonb(limits_row.allowed_actions),
      'allowedArchiveDestinations', pg_catalog.to_jsonb(limits_row.allowed_archive_destinations)
    ),
    'readinessEvidence', pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id,
      'registeredWorkflows', workflows,
      'activeConnections', connections
    )
  );
end
$$;
alter function vortex_record.read_application_lifecycle_policy_readiness(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Complete executable-policy snapshot for one activating Application installation: every owned record type''s current policy, the organisation ceilings and the live archive readiness those policies name.';

REVOKE ALL ON FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;

create or replace function vortex_record.read_provisioned_lifecycle_policy_setup(
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
  expected_item jsonb;
  expected_root uuid;
  expected_revision bigint;
  previous_expected_root text;
  projection jsonb;
  projection_item jsonb;
  projection_storage_item jsonb;
  previous_projection_root text;
  previous_projection_storage text;
  previous_union_storage text;
  storage_ids uuid[] := array[]::uuid[];
  storage_id uuid;
  authority record;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  context_after_lock jsonb;
  context_at_completion jsonb;
  install_decision record;
  install_scope_decision record;
  final_decision record;
  platform_permission record;
  completed_at timestamptz;
  expected_binding_count integer := 0;
  target_ordinal integer := 0;
  source_bindings jsonb;
  target_application_root_id uuid;
  target_policy jsonb;
  limits_value jsonb;
  targets_value jsonb := '[]'::jsonb;
  target_value jsonb;
  policy_found boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_expected_module_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Provisioned lifecycle setup request is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_expected_module_bindings) not between 1 and 10000 then
    raise exception using errcode = '22023',
      message = 'Provisioned lifecycle setup request is invalid';
  end if;

  for expected_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings)
      with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    expected_binding_count := expected_binding_count + 1;
    if pg_catalog.jsonb_typeof(expected_item) <> 'object'
      or not expected_item ?& array['moduleRootId', 'bindingRevision']
      or expected_item - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(expected_item -> 'moduleRootId') <> 'string'
      or not vortex_platform.is_non_nil_uuid(expected_item ->> 'moduleRootId')
      or (expected_item ->> 'moduleRootId') <> pg_catalog.lower(expected_item ->> 'moduleRootId')
      or not vortex_record.is_lifecycle_revision_value(expected_item -> 'bindingRevision') then
      raise exception using errcode = '22023',
        message = 'Provisioned lifecycle setup request is invalid';
    end if;
    if previous_expected_root is not null
      and previous_expected_root collate "C"
        >= (expected_item ->> 'moduleRootId') collate "C" then
      raise exception using errcode = '22023',
        message = 'Provisioned lifecycle setup request is not canonical';
    end if;
    previous_expected_root := expected_item ->> 'moduleRootId';
  end loop;

  select locked.* into strict authority
  from vortex_access.lock_record_lifecycle_policy_authority() as locked;
  if authority.application_root_id is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Provisioned lifecycle setup authority is unavailable';
  end if;
  context_after_lock := vortex_access.validated_human_request_context();
  if context_after_lock is null
    or pg_catalog.jsonb_typeof(context_after_lock) <> 'object'
    or not context_after_lock ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'identityId', 'sessionId', 'authenticationStrength',
      'issuedAt', 'expiresAt', 'accessVersion', 'correlationId'
    ]
    or context_after_lock ->> 'callerKind' is distinct from 'human'
    or context_after_lock ->> 'applicationRootId' is distinct from p_application_root_id::text
    or context_after_lock ->> 'organizationId' is distinct from authority.organization_id::text
    or context_after_lock ->> 'organizationAccountId' is distinct from
      authority.organization_account_id::text
    or context_after_lock ->> 'accessVersion' is distinct from authority.access_version::text
    or context_after_lock ->> 'correlationId' is distinct from authority.correlation_id::text then
    raise exception using errcode = '42501',
      message = 'Provisioned lifecycle setup authority is unavailable';
  end if;

  projection := vortex_definition.read_provisioned_lifecycle_setup_targets_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  if projection is null
    or pg_catalog.jsonb_typeof(projection) <> 'object'
    or not projection ?& array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'registrationRevision', 'moduleBindings', 'storageContractIds'
    ]
    or projection - array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'registrationRevision', 'moduleBindings', 'storageContractIds'
    ] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(projection ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(projection ->> 'applicationRootId')
    or pg_catalog.lower(projection ->> 'organizationId') <> authority.organization_id::text
    or pg_catalog.lower(projection ->> 'applicationRootId') <> p_application_root_id::text
    or not vortex_record.is_lifecycle_revision_value(projection -> 'applicationReleaseRevision')
    or (projection ->> 'applicationReleaseRevision')::bigint <> p_application_release_revision
    or not vortex_record.is_lifecycle_revision_value(projection -> 'registrationRevision')
    or pg_catalog.jsonb_typeof(projection -> 'moduleBindings') <> 'array'
    or pg_catalog.jsonb_typeof(projection -> 'storageContractIds') <> 'array' then
    raise exception using errcode = '40001',
      message = 'Provisioned lifecycle setup source changed';
  end if;
  if pg_catalog.jsonb_array_length(projection -> 'moduleBindings') <> expected_binding_count then
    raise exception using errcode = '40001',
      message = 'Provisioned lifecycle setup source changed';
  end if;

  for projection_item in
    select item.value
    from pg_catalog.jsonb_array_elements(projection -> 'moduleBindings')
      with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    if pg_catalog.jsonb_typeof(projection_item) <> 'object'
      or not projection_item ?& array[
        'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state', 'storageContractIds'
      ]
      or projection_item - array[
        'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state', 'storageContractIds'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(projection_item -> 'moduleRootId') <> 'string'
      or not vortex_platform.is_non_nil_uuid(projection_item ->> 'moduleRootId')
      or (projection_item ->> 'moduleRootId') <> pg_catalog.lower(projection_item ->> 'moduleRootId')
      or not vortex_record.is_lifecycle_revision_value(projection_item -> 'moduleReleaseRevision')
      or not vortex_record.is_lifecycle_revision_value(projection_item -> 'bindingRevision')
      or projection_item ->> 'state' is distinct from 'provisioned'
      or pg_catalog.jsonb_typeof(projection_item -> 'storageContractIds') <> 'array' then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source is incomplete';
    end if;
    if previous_projection_root is not null
      and previous_projection_root collate "C"
        >= (projection_item ->> 'moduleRootId') collate "C" then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source is not canonical';
    end if;
    previous_projection_root := projection_item ->> 'moduleRootId';
    expected_root := (projection_item ->> 'moduleRootId')::uuid;
    expected_revision := (projection_item ->> 'bindingRevision')::bigint;
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
      where (expected.value ->> 'moduleRootId')::uuid = expected_root
        and (expected.value ->> 'bindingRevision')::bigint = expected_revision
    ) then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source changed';
    end if;

    previous_projection_storage := null;
    for projection_storage_item in
      select storage_item.value
      from pg_catalog.jsonb_array_elements(projection_item -> 'storageContractIds')
        with ordinality as storage_item(value, ordinal)
      order by storage_item.ordinal
    loop
      if pg_catalog.jsonb_typeof(projection_storage_item) <> 'string'
        or not vortex_platform.is_non_nil_uuid(projection_storage_item #>> '{}')
        or (projection_storage_item #>> '{}') <> pg_catalog.lower(projection_storage_item #>> '{}') then
        raise exception using errcode = '40001',
          message = 'Provisioned lifecycle setup source is incomplete';
      end if;
      if previous_projection_storage is not null
        and previous_projection_storage collate "C"
          >= (projection_storage_item #>> '{}') collate "C" then
        raise exception using errcode = '40001',
          message = 'Provisioned lifecycle setup source is not canonical';
      end if;
      previous_projection_storage := projection_storage_item #>> '{}';
      storage_id := (projection_storage_item #>> '{}')::uuid;
      if not storage_id = any (storage_ids) then
        storage_ids := pg_catalog.array_append(storage_ids, storage_id);
      end if;
    end loop;
  end loop;

  -- An installation whose Modules hold no record types yet has no policy targets to set up.
  storage_ids := array(select distinct item.value from pg_catalog.unnest(storage_ids) item(value)
    order by item.value);
  if pg_catalog.jsonb_array_length(projection -> 'storageContractIds') <>
    pg_catalog.cardinality(storage_ids) then
    raise exception using errcode = '40001',
      message = 'Provisioned lifecycle setup source is incomplete';
  end if;
  target_ordinal := 0;
  for projection_storage_item in
    select item.value
    from pg_catalog.jsonb_array_elements(projection -> 'storageContractIds')
      with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    target_ordinal := target_ordinal + 1;
    if pg_catalog.jsonb_typeof(projection_storage_item) <> 'string'
      or not vortex_platform.is_non_nil_uuid(projection_storage_item #>> '{}')
      or (projection_storage_item #>> '{}') <> pg_catalog.lower(projection_storage_item #>> '{}')
      or (projection_storage_item #>> '{}') <> storage_ids[target_ordinal]::text
      or (previous_union_storage is not null
        and previous_union_storage collate "C"
          >= (projection_storage_item #>> '{}') collate "C") then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source is not canonical';
    end if;
    previous_union_storage := projection_storage_item #>> '{}';
  end loop;

  select stored.* into limits_row
  from vortex_record.organization_lifecycle_limits as stored
  where stored.organization_id = authority.organization_id
  for share;
  if not found
    or limits_row.settings_revision not between 1 and 9007199254740991
    or not vortex_record.is_lifecycle_action_list(limits_row.allowed_actions)
    or not vortex_record.is_lifecycle_destination_list(limits_row.allowed_archive_destinations)
    or limits_row.allow_unlimited_retention_days is distinct from
      (limits_row.max_retention_days is null)
    or limits_row.allow_unlimited_record_count is distinct from
      (limits_row.max_record_count is null) then
    raise exception using errcode = '23514',
      message = 'Provisioned lifecycle settings are incomplete';
  end if;
  limits_value := pg_catalog.jsonb_build_object(
    'organizationId', limits_row.organization_id,
    'settingsRevision', limits_row.settings_revision,
    'maxRetentionDays', limits_row.max_retention_days,
    'maxRecordCount', limits_row.max_record_count,
    'allowUnlimitedRetentionDays', limits_row.allow_unlimited_retention_days,
    'allowUnlimitedRecordCount', limits_row.allow_unlimited_record_count,
    'allowedActions', pg_catalog.to_jsonb(limits_row.allowed_actions),
    'allowedArchiveDestinations', pg_catalog.to_jsonb(limits_row.allowed_archive_destinations)
  );

  for storage_id in select item.value from pg_catalog.unnest(storage_ids) item(value)
    order by item.value
  loop
    select stored.* into catalogue_row
    from vortex_record.storage_catalogue as stored
    where stored.storage_contract_id = storage_id
      and stored.state = 'active'
    for share;
    if not found then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle target is incomplete';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', binding.value ->> 'moduleRootId',
        'moduleReleaseRevision', (binding.value ->> 'moduleReleaseRevision')::bigint,
        'bindingRevision', (binding.value ->> 'bindingRevision')::bigint
      ) order by (binding.value ->> 'moduleRootId') collate "C"
    ) into source_bindings
    from pg_catalog.jsonb_array_elements(projection -> 'moduleBindings') as binding(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(binding.value -> 'storageContractIds') as source(value)
      where (source.value #>> '{}')::uuid = storage_id
    );
    if source_bindings is null or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(source_bindings) as source(value)
      where (source.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id
    ) then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle target source is incomplete';
    end if;

    target_application_root_id := case
      when catalogue_row.storage_scope = 'organization_shared' then null
      when catalogue_row.storage_scope = 'application_contained' then p_application_root_id
      else null
    end;
    if catalogue_row.storage_scope not in ('organization_shared', 'application_contained') then
      raise exception using errcode = '23514',
        message = 'Provisioned lifecycle target scope is invalid';
    end if;

    select stored.* into policy_row
    from vortex_record.record_type_lifecycle_policies as stored
    where stored.organization_id = authority.organization_id
      and stored.storage_contract_id = storage_id
      and stored.application_root_id is not distinct from target_application_root_id
    for share;
    policy_found := found;
    if not policy_found then
      target_policy := pg_catalog.jsonb_build_object('state', 'absent');
    else
      if not vortex_record.is_record_type_lifecycle_policy(policy_row.policy_body)
        or pg_catalog.lower(policy_row.policy_body ->> 'policyId') is distinct from
          policy_row.policy_id::text
        or pg_catalog.lower(policy_row.policy_body ->> 'organizationId') is distinct from
          authority.organization_id::text
        or pg_catalog.lower(policy_row.policy_body ->> 'storageContractId') is distinct from
          storage_id::text
        or pg_catalog.lower(policy_row.policy_body ->> 'applicationRootId') is distinct from
          target_application_root_id::text
        or policy_row.policy_body ->> 'policyRevision' is distinct from
          policy_row.policy_revision::text
        or policy_row.policy_body ->> 'action' is distinct from policy_row.action then
        raise exception using errcode = '23514',
          message = 'Provisioned lifecycle policy is inconsistent';
      end if;
      target_policy := pg_catalog.jsonb_build_object(
        'state', 'configured',
        'policyId', policy_row.policy_id,
        'policyRevision', policy_row.policy_revision,
        'policyBody', policy_row.policy_body
      );
    end if;

    target_value := pg_catalog.jsonb_build_object(
      'storageContractId', storage_id,
      'storageScope', catalogue_row.storage_scope,
      'applicationRootId', target_application_root_id,
      'sourceBindings', source_bindings,
      'policy', target_policy
    );
    targets_value := targets_value || pg_catalog.jsonb_build_array(target_value);
  end loop;

  -- Re-evaluate all authority after every Module and Record lock wait. The
  -- installation delegation can expire without an Access-version change, so
  -- the request context alone is not sufficient completion evidence. The
  -- request-role caller repeats all three decisions after validating the DTO.
  select entry.owner_id, entry.permission_id into strict platform_permission
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registrations as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
    and registration.state = 'active'
  where entry.organization_id = authority.organization_id
    and entry.registration_kind = 'platform'
    and entry.owner_kind = 'platform'
    and entry.permission_key = 'platform.organization.applications.manage'
    and entry.action_kind = 'manage';
  select evaluated.* into strict install_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', platform_permission.owner_id,
        'permissionId', platform_permission.permission_id
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  select evaluated.* into strict install_scope_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', platform_permission.owner_id,
        'permissionId', platform_permission.permission_id
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  select evaluated.* into strict final_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', platform_permission.owner_id,
        'permissionId', platform_permission.permission_id
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  context_at_completion := vortex_access.validated_human_request_context();
  completed_at := pg_catalog.clock_timestamp();
  if context_at_completion is null
    or pg_catalog.jsonb_typeof(context_at_completion) <> 'object'
    or not context_at_completion ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'identityId', 'sessionId', 'authenticationStrength',
      'issuedAt', 'expiresAt', 'accessVersion', 'correlationId'
    ]
    or final_decision.outcome is distinct from 'eligible'
    or final_decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or final_decision.organization_id is distinct from authority.organization_id
    or final_decision.organization_account_id is distinct from authority.organization_account_id
    or final_decision.access_version is distinct from authority.access_version
    or final_decision.correlation_id is distinct from authority.correlation_id
    or final_decision.target_kind is distinct from 'organization'
    or final_decision.target_application_root_id is not null
    or final_decision.reason_code is not null
    or final_decision.valid_until is null
    or final_decision.checked_at is null
    or final_decision.checked_at > completed_at
    or final_decision.valid_until <= completed_at
    or install_decision.outcome is distinct from 'eligible'
    or install_decision.operation_key is distinct from
      'platform.organization.applications.install'
    or install_decision.organization_id is distinct from authority.organization_id
    or install_decision.organization_account_id is distinct from authority.organization_account_id
    or install_decision.access_version is distinct from authority.access_version
    or install_decision.correlation_id is distinct from authority.correlation_id
    or install_decision.target_kind is distinct from 'organization'
    or install_decision.target_application_root_id is not null
    or install_decision.reason_code is not null
    or install_decision.valid_until is null
    or install_decision.checked_at is null
    or install_decision.checked_at > completed_at
    or install_decision.valid_until <= completed_at
    or install_scope_decision.outcome is distinct from 'eligible'
    or install_scope_decision.operation_key is distinct from
      'platform.organization.applications.install_scope'
    or install_scope_decision.organization_id is distinct from authority.organization_id
    or install_scope_decision.organization_account_id is distinct from
      authority.organization_account_id
    or install_scope_decision.access_version is distinct from authority.access_version
    or install_scope_decision.correlation_id is distinct from authority.correlation_id
    or install_scope_decision.target_kind is distinct from 'organization'
    or install_scope_decision.target_application_root_id is not null
    or install_scope_decision.reason_code is not null
    or install_scope_decision.valid_until is null
    or install_scope_decision.checked_at is null
    or install_scope_decision.checked_at > completed_at
    or install_scope_decision.valid_until <= completed_at
    or context_at_completion ->> 'callerKind' is distinct from 'human'
    or context_at_completion ->> 'tenantId' is distinct from context_after_lock ->> 'tenantId'
    or context_at_completion ->> 'organizationId' is distinct from authority.organization_id::text
    or context_at_completion ->> 'organizationAccountId' is distinct from
      authority.organization_account_id::text
    or context_at_completion ->> 'applicationRootId' is distinct from p_application_root_id::text
    or context_at_completion ->> 'accessVersion' is distinct from authority.access_version::text
    or context_at_completion ->> 'correlationId' is distinct from authority.correlation_id::text
    or context_at_completion ->> 'identityId' is distinct from context_after_lock ->> 'identityId'
    or context_at_completion ->> 'sessionId' is distinct from context_after_lock ->> 'sessionId'
    or context_at_completion ->> 'authenticationStrength' is distinct from
      context_after_lock ->> 'authenticationStrength'
    or context_at_completion ->> 'accessTokenIssuedAt' is distinct from
      context_after_lock ->> 'accessTokenIssuedAt'
    or context_at_completion ->> 'primaryAuthenticatedAt' is distinct from
      context_after_lock ->> 'primaryAuthenticatedAt'
    or context_at_completion ->> 'multiFactorAuthenticatedAt' is distinct from
      context_after_lock ->> 'multiFactorAuthenticatedAt'
    or context_at_completion ->> 'issuedAt' is distinct from context_after_lock ->> 'issuedAt'
    or context_at_completion ->> 'expiresAt' is distinct from context_after_lock ->> 'expiresAt'
    or (context_at_completion ->> 'issuedAt')::timestamptz > completed_at
    or (context_at_completion ->> 'expiresAt')::timestamptz <= completed_at then
    raise exception using errcode = '42501',
      message = 'Provisioned lifecycle setup authority expired';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'registrationRevision', (projection ->> 'registrationRevision')::bigint,
    'organizationLimits', limits_value,
    'targets', targets_value
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Provisioned lifecycle setup evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Provisioned lifecycle setup evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Provisioned lifecycle setup request is invalid';
end
$function$;
alter function vortex_record.read_provisioned_lifecycle_policy_setup(uuid,bigint,jsonb) owner to vortex_owner;


alter function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb)
  owner to vortex_owner;

revoke all on function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb)
  to vortex_request;

comment on function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb) is
  'Read-only first-install projection of lifecycle limits and exact provisioned storage policies; binds a complete Module projection to current HUMAN policy-management authority.';

create or replace function vortex_definition.read_active_shared_record_consumers_internal(
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
  context_value jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_access_version bigint;
  candidate_application_root_id uuid;
  application_installation jsonb;
  application_root vortex_definition.roots%rowtype;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  module_binding_fact jsonb;
  module_binding vortex_definition.installation_bindings%rowtype;
  module_root vortex_definition.roots%rowtype;
  module_release vortex_definition.releases%rowtype;
  storage_provision record;
  module_bindings jsonb;
  targets jsonb := '[]'::jsonb;
  target jsonb;
  target_record_types jsonb;
  target_record_type_count integer;
  own_module_binding_count integer;
  binding_count integer;
begin
  if p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Shared record consumer selection is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(context_value) is distinct from 'object'
    or not (context_value ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'accessVersion', 'correlationId'
    ])
    or context_value ->> 'callerKind' is distinct from 'human'
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'applicationRootId')
    or not vortex_platform.is_non_nil_uuid(context_value ->> 'correlationId')
    or not pg_catalog.pg_input_is_valid(context_value ->> 'accessVersion', 'bigint')
    or (context_value ->> 'accessVersion')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Shared record consumer request context is unavailable';
  end if;
  selected_organization_id := (context_value ->> 'organizationId')::uuid;
  selected_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  selected_access_version := (context_value ->> 'accessVersion')::bigint;

  <<application_loop>>
  for candidate_application_root_id in
    select distinct binding.application_root_id
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.module_root_id = p_module_root_id
      and binding.state = 'active'
    order by binding.application_root_id
  loop
    select snapshot.* into permission_snapshot
    from vortex_access.read_application_permission_snapshot(
      selected_organization_id, candidate_application_root_id
    ) as snapshot;
    if not found then
      continue application_loop;
    end if;

    select root.* into application_root
    from vortex_definition.roots as root
    where root.root_id = candidate_application_root_id;
    if not found
      or application_root.kind is distinct from 'application'
      or application_root.organization_id is distinct from selected_organization_id
      or application_root.key is null or application_root.key = '' then
      continue application_loop;
    end if;

    if not pg_catalog.pg_input_is_valid(permission_snapshot.release_revision::text, 'bigint')
      or permission_snapshot.release_revision not between 1 and 9007199254740991 then
      continue application_loop;
    end if;
    select release.* into application_release
    from vortex_definition.releases as release
    where release.root_id = candidate_application_root_id
      and release.release_revision = permission_snapshot.release_revision;
    if not found
      or application_release.validation_contract_version is null
      or not (application_release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      ))
      or application_release.release_version is null
      or application_release.release_version = ''
      or application_release.content_fingerprint is null
      or application_release.content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or application_release.resolution_fingerprint is null
      or application_release.resolution_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(application_release.compilation_output) is distinct from 'object'
      or application_release.compilation_output ->> 'kind' is distinct from 'application'
      or application_release.compilation_output ->> 'validationContractVersion'
        is distinct from application_release.validation_contract_version
      or application_release.compilation_output #>> '{canonical,envelope,rootId}'
        is distinct from candidate_application_root_id::text
      or application_release.compilation_output #>> '{canonical,envelope,kind}'
        is distinct from 'application'
      or application_release.compilation_output #>> '{canonical,envelope,validationContractVersion}'
        is distinct from application_release.validation_contract_version then
      continue application_loop;
    end if;

    if permission_snapshot.organization_id is distinct from selected_organization_id
      or permission_snapshot.application_root_id is distinct from candidate_application_root_id
      or permission_snapshot.registration_revision is null
      or permission_snapshot.registration_revision not between 1 and 9007199254740991
      or permission_snapshot.release_revision is distinct from application_release.release_revision
      or permission_snapshot.definition_key is distinct from application_root.key
      or permission_snapshot.release_version is distinct from application_release.release_version
      or permission_snapshot.validation_contract_version
        is distinct from application_release.validation_contract_version
      or permission_snapshot.content_fingerprint is distinct from application_release.content_fingerprint
      or permission_snapshot.resolution_fingerprint is distinct from application_release.resolution_fingerprint
      or permission_snapshot.catalogue_fingerprint is null
      or permission_snapshot.catalogue_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
      continue application_loop;
    end if;

    begin
      application_installation := vortex_definition.read_active_installation_for_scope_internal(
        selected_organization_id, candidate_application_root_id
      );
    exception
      when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
        continue application_loop;
    end;

    if pg_catalog.jsonb_typeof(application_installation) is distinct from 'object'
      or not (application_installation ?& array[
        'organizationId', 'applicationRootId', 'applicationReleaseRevision', 'moduleBindings'
      ])
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(application_installation)) <> 4
      or application_installation ->> 'organizationId' is distinct from selected_organization_id::text
      or application_installation ->> 'applicationRootId' is distinct from candidate_application_root_id::text
      or application_installation ->> 'applicationReleaseRevision'
        is distinct from application_release.release_revision::text
      or pg_catalog.jsonb_typeof(application_installation -> 'moduleBindings') is distinct from 'array'
      or pg_catalog.jsonb_array_length(application_installation -> 'moduleBindings') = 0 then
      raise exception using errcode = '55000',
        message = 'Active shared record consumer evidence is malformed';
    end if;

    select pg_catalog.count(*)::integer into binding_count
    from pg_catalog.jsonb_array_elements(application_installation -> 'moduleBindings') as item(value);
    module_bindings := '[]'::jsonb;
    own_module_binding_count := 0;

    for module_binding_fact in
      select item.value
      from pg_catalog.jsonb_array_elements(application_installation -> 'moduleBindings') as item(value)
      order by (item.value ->> 'moduleRootId')::uuid
    loop
      if pg_catalog.jsonb_typeof(module_binding_fact) is distinct from 'object'
        or not (module_binding_fact ?& array[
          'organizationId', 'applicationRootId', 'moduleRootId', 'bindingRevision',
          'applicationReleaseRevision', 'moduleReleaseRevision', 'state'
        ])
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_binding_fact)) <> 7
        or not vortex_platform.is_non_nil_uuid(module_binding_fact ->> 'moduleRootId')
        or not pg_catalog.pg_input_is_valid(module_binding_fact ->> 'bindingRevision', 'bigint')
        or (module_binding_fact ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
        or not pg_catalog.pg_input_is_valid(module_binding_fact ->> 'moduleReleaseRevision', 'bigint')
        or (module_binding_fact ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or module_binding_fact ->> 'organizationId' is distinct from selected_organization_id::text
        or module_binding_fact ->> 'applicationRootId' is distinct from candidate_application_root_id::text
        or module_binding_fact ->> 'applicationReleaseRevision'
          is distinct from application_release.release_revision::text
        or module_binding_fact ->> 'state' is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Active shared record consumer binding evidence is malformed';
      end if;

      select binding.* into module_binding
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = selected_organization_id
        and binding.application_root_id = candidate_application_root_id
        and binding.module_root_id = (module_binding_fact ->> 'moduleRootId')::uuid;
      if not found
        or module_binding.state is distinct from 'active'
        or module_binding.binding_revision is distinct from (module_binding_fact ->> 'bindingRevision')::bigint
        or module_binding.application_release_revision is distinct from application_release.release_revision
        or module_binding.module_release_revision is distinct from (module_binding_fact ->> 'moduleReleaseRevision')::bigint then
        raise exception using errcode = '40001',
          message = 'Active shared record consumer binding changed during selection';
      end if;

      select root.* into module_root
      from vortex_definition.roots as root
      where root.root_id = module_binding.module_root_id;
      if not found or module_root.kind is distinct from 'module'
        or module_root.key is null or module_root.key = '' then
        continue application_loop;
      end if;
      select release.* into module_release
      from vortex_definition.releases as release
      where release.root_id = module_binding.module_root_id
        and release.release_revision = module_binding.module_release_revision;
      if not found
        or module_release.validation_contract_version is null
        or not (module_release.validation_contract_version = any (
          vortex_definition.accepted_contract_version('module')
        ))
        or module_release.release_version is null
        or module_release.release_version = ''
        or module_release.content_fingerprint is null
        or module_release.content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or module_release.resolution_fingerprint is null
        or module_release.resolution_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or pg_catalog.jsonb_typeof(module_release.compilation_output) is distinct from 'object'
        or module_release.compilation_output ->> 'kind' is distinct from 'module'
        or module_release.compilation_output ->> 'validationContractVersion'
          is distinct from module_release.validation_contract_version
        or module_release.compilation_output #>> '{canonical,envelope,rootId}'
          is distinct from module_binding.module_root_id::text
        or module_release.compilation_output #>> '{canonical,envelope,kind}'
          is distinct from 'module'
        or module_release.compilation_output #>> '{canonical,envelope,validationContractVersion}'
          is distinct from module_release.validation_contract_version then
        continue application_loop;
      end if;

      begin
        select provision.* into strict storage_provision
        from vortex_record.read_exact_module_storage_provision(
          module_binding.module_root_id, module_binding.module_release_revision
        ) as provision;
      exception
        when no_data_found then
          continue application_loop;
      end;
      if storage_provision.module_root_id is distinct from module_binding.module_root_id
        or storage_provision.release_revision is distinct from module_binding.module_release_revision
        or storage_provision.storage_contract_ids is null
        or module_binding.storage_contract_ids is distinct from storage_provision.storage_contract_ids
        or exists (
          select 1
          from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
          where stored.contract_id is null
            or stored.contract_id = '00000000-0000-0000-0000-000000000000'::uuid
        )
        or exists (
          select 1
          from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
          group by stored.contract_id having pg_catalog.count(*) <> 1
        )
        or storage_provision.storage_contract_ids is distinct from coalesce((
          select pg_catalog.array_agg(stored.contract_id order by stored.contract_id)
          from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
        ), array[]::uuid[]) then
        continue application_loop;
      end if;

      if module_binding.module_root_id = p_module_root_id then
        own_module_binding_count := own_module_binding_count + 1;
        target_record_types := module_release.compilation_output #> '{canonical,content,recordTypes}';
        if pg_catalog.jsonb_typeof(target_record_types) is distinct from 'array' then
          raise exception using errcode = '55000',
            message = 'Shared record type release evidence is malformed';
        end if;
        select pg_catalog.count(*)::integer into target_record_type_count
        from pg_catalog.jsonb_array_elements(target_record_types) as item(value)
        where item.value ->> 'recordTypeId' = p_record_type_id::text;
        if target_record_type_count <> 1 or not exists (
          select 1
          from pg_catalog.jsonb_array_elements(target_record_types) as item(value)
          where item.value ->> 'recordTypeId' = p_record_type_id::text
            and item.value ->> 'storageContractId' = p_storage_contract_id::text
            and item.value ->> 'storageScope' = 'organization_shared'
        ) then
          continue application_loop;
        end if;
        if not (p_storage_contract_id = any (storage_provision.storage_contract_ids)) then
          continue application_loop;
        end if;
      end if;

      module_bindings := module_bindings || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_binding.module_root_id,
          'bindingRevision', module_binding.binding_revision,
          'applicationReleaseRevision', module_binding.application_release_revision,
          'moduleReleaseRevision', module_binding.module_release_revision,
          'state', module_binding.state,
          'contentFingerprint', module_release.content_fingerprint,
          'resolutionFingerprint', module_release.resolution_fingerprint,
          'generatorContractVersion', '1.0.0',
          'storageContractIds', pg_catalog.to_jsonb(storage_provision.storage_contract_ids)
        )
      );
    end loop;

    if own_module_binding_count <> 1
      or pg_catalog.jsonb_array_length(module_bindings) <> binding_count then
      continue application_loop;
    end if;

    target := pg_catalog.jsonb_build_object(
      'applicationRootId', candidate_application_root_id,
      'applicationReleaseRevision', application_release.release_revision,
      'moduleRootId', p_module_root_id,
      'moduleReleaseRevision', (
        select binding.module_release_revision
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = selected_organization_id
          and binding.application_root_id = candidate_application_root_id
          and binding.module_root_id = p_module_root_id
          and binding.state = 'active'
      ),
      'bindingRevision', (
        select binding.binding_revision
        from vortex_definition.installation_bindings as binding
        where binding.organization_id = selected_organization_id
          and binding.application_root_id = candidate_application_root_id
          and binding.module_root_id = p_module_root_id
          and binding.state = 'active'
      ),
      'recordTypeId', p_record_type_id,
      'storageContractId', p_storage_contract_id,
      'registrationRevision', permission_snapshot.registration_revision,
      'definitionKey', application_root.key,
      'releaseVersion', application_release.release_version,
      'validationContractVersion', application_release.validation_contract_version,
      'contentFingerprint', application_release.content_fingerprint,
      'resolutionFingerprint', application_release.resolution_fingerprint,
      'catalogueFingerprint', permission_snapshot.catalogue_fingerprint,
      'moduleBindings', module_bindings
    );
    targets := targets || pg_catalog.jsonb_build_array(target);
  end loop;

  if pg_catalog.jsonb_array_length(targets) = 0 then
    raise exception using errcode = '42501',
      message = 'No active shared record consumer is available';
  end if;
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(targets) as item(value)
    where item.value ->> 'applicationRootId' = selected_application_root_id::text
  ) then
    raise exception using errcode = '42501',
      message = 'Origin Application is not a proved shared record consumer';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'accessVersion', selected_access_version,
    'targets', targets
  );
end
$function$;
alter function vortex_definition.read_active_shared_record_consumers_internal(uuid,uuid,uuid) owner to vortex_owner;


alter function vortex_definition.read_active_shared_record_consumers_internal(uuid, uuid, uuid)
  owner to vortex_owner;

revoke all on function vortex_definition.read_active_shared_record_consumers_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_active_shared_record_consumers_internal(uuid, uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_definition.read_active_shared_record_consumers_internal(uuid, uuid, uuid) is
  'Selects every exact active App consumer of one organization-shared record from the complete installed Module lineage and active exact release registration.';

reset role;
