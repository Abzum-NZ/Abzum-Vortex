set local role vortex_owner;

-- The current definitions publish only native bounded sort keys for these readers.
update vortex_record.protected_read_model_views as registered
set cursor_sort_keys = accepted.sort_keys
from (values
  ('people', array['record_id', 'starts_at', 'expires_at', 'state']::text[]),
  ('effective_assignments', array['record_id', 'starts_at', 'expires_at', 'state']::text[]),
  ('role_activations', array['record_id', 'activated_at', 'expires_at', 'state']::text[])
) as accepted(model_key, sort_keys)
where registered.protected_read_model_key = accepted.model_key;

create or replace function vortex_record.system_projection_columns_internal(p_record_type jsonb)
returns text
language plpgsql immutable security definer set search_path = ''
as $function$
declare
  field_value jsonb;
  field_id uuid;
  database_type text;
  columns_sql text := 'organisation_id uuid, module_root_id uuid, record_type_id uuid,
    storage_contract_id uuid, record_id uuid, application_root_id uuid,
    definition_revision bigint, owner_organisation_account_id uuid, owner_group_id uuid,
    lifecycle_state text, concurrency_number bigint, created_at timestamptz, created_by uuid,
    updated_at timestamptz, updated_by uuid, deleted_at timestamptz, deleted_by uuid,
    removal_due_at timestamptz';
begin
  if pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_record_type -> 'systemProjection') is distinct from 'object' then
    raise exception using errcode = '55000', message = 'Protected projection definition is invalid';
  end if;
  for field_value in
    select item.value from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := (field_value ->> 'fieldId')::uuid;
    database_type := vortex_record.database_value_type(field_value);
    if not vortex_platform.is_non_nil_uuid(field_id::text) or database_type is null then
      raise exception using errcode = '55000', message = 'Protected projection field is invalid';
    end if;
    columns_sql := columns_sql || pg_catalog.format(', %I %s',
      'f_' || pg_catalog.replace(field_id::text, '-', ''),
      vortex_record.sql_value_type(database_type));
  end loop;
  return columns_sql;
end
$function$;

alter function vortex_record.system_projection_columns_internal(jsonb) owner to vortex_owner;
revoke all on function vortex_record.system_projection_columns_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.system_projection_columns_internal(jsonb)
  to vortex_record_adapter, postgres;

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
  stored_field_meaning jsonb;
  requested_field_meaning jsonb;
  earlier_options jsonb;
  later_options jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
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
    if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
      where field.value -> 'sortable' = 'true'::jsonb) > 8 then
      raise exception using errcode = '23514', message = 'A record type may declare at most eight sortable fields';
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

    -- System projections keep definition and field mappings only. Every row
    -- is supplied by the registered bounded reader, never a record_data view.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      perform 1 from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501', message = 'Protected projection reader is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if not is_projection then
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value, true
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
      if stored_catalogue.record_type_definition ->> 'ownershipMode'
          is distinct from ownership_mode_value
        or stored_catalogue.record_type_definition ->> 'ownershipRelationshipId'
          is distinct from record_type ->> 'ownershipRelationshipId' then
        raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
      end if;
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token then
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
        -- describe the bounded reader values, including the
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
        stored_field_meaning := vortex_record.field_storage_meaning(stored_field.field_definition);
        requested_field_meaning := vortex_record.field_storage_meaning(field_value);
        if field_value ->> 'type' in ('choice', 'several_choices') then
          -- Shared storage retains the newest shape, even when an older exact
          -- release is checked again. Only additions preserve every option's
          -- stored value, label and permission; all other settings stay exact.
          if p_module_release_revision < stored_catalogue.last_compatible_release_revision then
            earlier_options := field_value #> '{settings,options}';
            later_options := stored_field.field_definition #> '{settings,options}';
          else
            earlier_options := stored_field.field_definition #> '{settings,options}';
            later_options := field_value #> '{settings,options}';
          end if;
          if pg_catalog.jsonb_typeof(earlier_options) is distinct from 'array'
            or pg_catalog.jsonb_typeof(later_options) is distinct from 'array'
            or exists (
              select 1 from pg_catalog.jsonb_array_elements(earlier_options) as earlier(value)
              where not exists (
                select 1 from pg_catalog.jsonb_array_elements(later_options) as later(value)
                where later.value = earlier.value
              )
            ) then
            raise exception using errcode = '55000',
              message = 'Choice storage upgrades must preserve existing options unchanged';
          end if;
          stored_field_meaning := stored_field_meaning #- '{settings,options}';
          requested_field_meaning := requested_field_meaning #- '{settings,options}';
        end if;
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or stored_field_meaning is distinct from requested_field_meaning
          or (not is_projection and not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          )) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
        if field_value ->> 'type' in ('choice', 'several_choices')
          and p_module_release_revision > stored_catalogue.last_compatible_release_revision
          and stored_field.field_definition is distinct from field_value then
          update vortex_record.field_storage_mappings
          set field_definition = field_value
          where storage_contract_id = storage_id and field_id = field_id_value;
          any_change := true;
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
        -- A projection field has no generated column or index. Its protected
        -- reader applies visibility, ordering and filtering.
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
  'Private exact-release Module storage provisioner: creates or evolves generated record_data storage, or registers definition and field mappings for a system projection read only through its bounded protected reader, for one published Module release.';

create or replace function vortex_record.create_system_projection_companion_storage_internal(
  p_storage_contract_id uuid,
  p_target_module_root_id uuid,
  p_record_type_id uuid,
  p_contributor_module_root_id uuid,
  p_field_definition jsonb,
  p_validate_only boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_id_value uuid;
  database_type text;
  sql_type text;
  table_token text;
  column_token text;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  reader_function_oid oid;
  relation_oid oid;
  owner_role_oid oid := 'vortex_owner'::regrole::oid;
  adapter_role_oid oid := 'vortex_record_adapter'::regrole::oid;
  has_mapping boolean;
  expected_columns text[];
  existing_columns text[];
  acl_adapter_count integer;
  acl_adapter_invalid_count integer;
  acl_other_count integer;
  policy_expression text;
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_contributor_module_root_id::text)
    or p_target_module_root_id = p_contributor_module_root_id
    or pg_catalog.jsonb_typeof(p_field_definition) is distinct from 'object'
    or p_validate_only is null then
    raise exception using errcode = '22023',
      message = 'Projection companion storage identity is invalid';
  end if;

  begin
    field_id_value := (p_field_definition ->> 'fieldId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Projection companion field identity is invalid';
  end;
  if not vortex_platform.is_non_nil_uuid(field_id_value::text)
    or p_field_definition -> 'required' is distinct from 'false'::jsonb
    or p_field_definition -> 'unique' is distinct from 'false'::jsonb
    or p_field_definition -> 'filterable' is distinct from 'false'::jsonb
    or p_field_definition -> 'sortable' is distinct from 'false'::jsonb then
    raise exception using errcode = '23514',
      message = 'A system projection contribution must be optional and unindexed';
  end if;
  database_type := vortex_record.database_value_type(p_field_definition);
  sql_type := vortex_record.sql_value_type(database_type);
  if database_type is null or sql_type is null
    or pg_catalog.to_regtype(sql_type) is null then
    raise exception using errcode = '23514',
      message = 'Contributed field type is unsupported';
  end if;

  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
  for update;
  protected_view_key := catalogue_row.protected_read_model_key;
  table_token := 'cp_' || pg_catalog.replace(
    pg_catalog.lower(p_storage_contract_id::text), '-', ''
  );
  column_token := 'f_' || pg_catalog.replace(
    pg_catalog.lower(field_id_value::text), '-', ''
  );
  if catalogue_row.module_root_id <> p_target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from 'organization_shared'
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'system_projection'
    or catalogue_row.physical_table_token is distinct from
      ('rt_' || pg_catalog.replace(pg_catalog.lower(p_storage_contract_id::text), '-', ''))
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
      message = 'Protected projection reader is unavailable';
  end if;
  reader_function_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.%I(uuid[],text,text,jsonb,integer,jsonb)', reader_schema_value, reader_function_value
  ))::oid;
  if reader_function_oid is null or not exists (
    select 1 from pg_catalog.pg_proc as reader
    where reader.oid = reader_function_oid and reader.prosecdef
      and reader.proowner = owner_role_oid
      and reader.proconfig @> array['search_path=""']::text[]
  ) then
    raise exception using errcode = '55000',
      message = 'Protected projection reader lineage is incompatible';
  end if;

  select mapping.* into mapping_row
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = field_id_value
  for update;
  has_mapping := found;
  if has_mapping then
    if mapping_row.introduced_by_module_root_id <> p_contributor_module_root_id
      or mapping_row.physical_column_token <> column_token
      or mapping_row.database_value_type <> database_type
      or mapping_row.state not in ('active', 'retired')
      or vortex_record.field_storage_meaning(mapping_row.field_definition)
        is distinct from vortex_record.field_storage_meaning(p_field_definition) then
      raise exception using errcode = '55000',
        message = 'Existing contributed field storage is incompatible';
    end if;
  end if;

  if exists (
    select 1
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.introduced_by_module_root_id <> p_target_module_root_id
      and mapping.state not in ('active', 'retired')
  ) then
    raise exception using errcode = '55000',
      message = 'Existing contributed field storage is incompatible';
  end if;
  select coalesce(
      pg_catalog.array_agg(mapping.physical_column_token order by mapping.physical_column_token),
      array[]::text[]
    )
  into expected_columns
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.introduced_by_module_root_id <> p_target_module_root_id;

  relation_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token))::oid;
  if relation_oid is null then
    if has_mapping or pg_catalog.cardinality(expected_columns) > 0 then
      raise exception using errcode = '55000',
        message = 'Existing contributed field storage is incompatible';
    end if;
    if p_validate_only then
      return;
    end if;
    execute pg_catalog.format(
      'create table record_data.%I (
        organisation_id uuid not null,
        record_id uuid not null,
        %I %s,
        primary key (organisation_id, record_id)
      )', table_token, column_token, sql_type
    );
    execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
    execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
    execute pg_catalog.format(
      'create policy projection_companion_record_access on record_data.%I
        for all to vortex_record_adapter
        using (organisation_id = vortex_platform.organization_id())
        with check (organisation_id = vortex_platform.organization_id())', table_token
    );
    execute pg_catalog.format(
      'revoke all on record_data.%I from public, anon, authenticated, service_role,
        vortex_runtime, vortex_request, vortex_owner', table_token
    );
    execute pg_catalog.format(
      'grant select, insert, update on record_data.%I to vortex_record_adapter', table_token
    );
    expected_columns := expected_columns || column_token;
  else
    if not exists (
      select 1
      from pg_catalog.pg_class as relation
      where relation.oid = relation_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and not relation.relispartition
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    )
      or exists (
        select 1 from pg_catalog.pg_inherits as inheritance
        where inheritance.inhrelid = relation_oid
      )
      or exists (
        select 1 from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid = relation_oid and not trigger.tgisinternal
      )
      or exists (
        select 1 from pg_catalog.pg_rewrite as rule
        where rule.ev_class = relation_oid
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;
    select coalesce(
        pg_catalog.array_agg(attribute.attname order by attribute.attname),
        array[]::text[]
      )
    into existing_columns
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = relation_oid
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname not in ('organisation_id', 'record_id');
    if existing_columns is distinct from expected_columns
      or exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname in ('organisation_id', 'record_id')
          and (attribute.atttypid <> 'uuid'::regtype
            or not attribute.attnotnull
            or attribute.atthasdef
            or exists (
              select 1 from pg_catalog.pg_attrdef as default_row
              where default_row.adrelid = attribute.attrelid
                and default_row.adnum = attribute.attnum
            )
            or attribute.attgenerated <> ''
            or attribute.attidentity <> ''
            or attribute.attnum < 1
            or attribute.attisdropped)
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname in ('organisation_id', 'record_id')
          and attribute.attnum > 0 and not attribute.attisdropped
      ) <> 2
      or exists (
        select 1
        from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_oid
          and constraint_row.contype <> 'p'
      )
      or not exists (
        select 1
        from pg_catalog.pg_constraint as constraint_row
        cross join lateral pg_catalog.unnest(constraint_row.conkey)
          with ordinality as key_column(attnum, ordinal_position)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = relation_oid and attribute.attnum = key_column.attnum
        where constraint_row.conrelid = relation_oid
          and constraint_row.contype = 'p'
        group by constraint_row.oid, constraint_row.convalidated
        having constraint_row.convalidated
          and not constraint_row.condeferrable
          and not constraint_row.condeferred
          and pg_catalog.array_agg(attribute.attname order by key_column.ordinal_position)
            = array['organisation_id', 'record_id']::name[]
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_oid and constraint_row.contype = 'p'
      ) <> 1
      or exists (
        select 1 from pg_catalog.pg_index as index_row
        where index_row.indrelid = relation_oid and not index_row.indisprimary
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;

    if exists (
      select 1
      from vortex_record.field_storage_mappings as mapping
      left join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation_oid
        and attribute.attname = mapping.physical_column_token
        and attribute.attnum > 0 and not attribute.attisdropped
      left join pg_catalog.pg_attrdef as default_row
        on default_row.adrelid = attribute.attrelid
        and default_row.adnum = attribute.attnum
      where mapping.storage_contract_id = p_storage_contract_id
        and mapping.introduced_by_module_root_id <> p_target_module_root_id
        and (attribute.attnum is null
          or attribute.attnotnull
          or attribute.atthasdef
          or default_row.oid is not null
          or attribute.attgenerated <> ''
          or attribute.attidentity <> ''
          or attribute.atttypid is distinct from
            pg_catalog.to_regtype(vortex_record.sql_value_type(mapping.database_value_type))::oid)
    ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;
    if not has_mapping then
      if exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname = column_token
          and attribute.attnum > 0 and not attribute.attisdropped
      ) then
        raise exception using errcode = '55000',
          message = 'Existing contributed field storage is incompatible';
      end if;
      expected_columns := expected_columns || column_token;
    end if;

    select pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE')
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and (privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
            or privilege.is_grantable)
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee not in (owner_role_oid, adapter_role_oid)
      )
    into acl_adapter_count, acl_adapter_invalid_count, acl_other_count
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) as privilege
    where relation.oid = relation_oid;
    if acl_adapter_count <> 3
      or acl_adapter_invalid_count <> 0
      or acl_other_count <> 0
      or exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid and attribute.attacl is not null
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion grants are incompatible';
    end if;

    select pg_catalog.regexp_replace(pg_catalog.lower(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
      ), '\s+', '', 'g')
    into policy_expression
    from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_oid
      and policy.polname = 'projection_companion_record_access';
    if policy_expression is distinct from '(organisation_id=vortex_platform.organization_id())'
      or not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
          and policy.polname = 'projection_companion_record_access'
          and policy.polpermissive
          and policy.polcmd = '*'
          and policy.polroles = array[adapter_role_oid]::oid[]
          and pg_catalog.regexp_replace(pg_catalog.lower(
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
          ), '\s+', '', 'g')
            = '(organisation_id=vortex_platform.organization_id())'
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
      ) <> 1 then
      raise exception using errcode = '55000',
        message = 'Existing projection companion policies are incompatible';
    end if;

    if p_validate_only then
      return;
    end if;
    if not has_mapping then
      execute pg_catalog.format(
        'alter table record_data.%I add column %I %s', table_token, column_token, sql_type
      );
    end if;
  end if;

  relation_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token))::oid;
  select coalesce(
      pg_catalog.array_agg(expected_column.value order by expected_column.value),
      array[]::text[]
    )
  into expected_columns
  from pg_catalog.unnest(expected_columns) as expected_column(value);
  select coalesce(
      pg_catalog.array_agg(attribute.attname order by attribute.attname),
      array[]::text[]
    )
  into existing_columns
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = relation_oid
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attname not in ('organisation_id', 'record_id');
  if existing_columns is distinct from expected_columns
    or not exists (
      select 1 from pg_catalog.pg_attribute as attribute
      where attribute.attrelid = relation_oid
        and attribute.attname = column_token
        and attribute.attnum > 0 and not attribute.attisdropped
        and not attribute.attnotnull
        and not attribute.atthasdef
        and not exists (
          select 1 from pg_catalog.pg_attrdef as default_row
          where default_row.adrelid = attribute.attrelid
            and default_row.adnum = attribute.attnum
        )
        and attribute.attgenerated = ''
        and attribute.attidentity = ''
        and attribute.atttypid = pg_catalog.to_regtype(sql_type)::oid
    ) then
    raise exception using errcode = '55000',
      message = 'Existing projection companion relation is incompatible';
  end if;
end
$function$;
alter function vortex_record.create_system_projection_companion_storage_internal(uuid,uuid,uuid,uuid,jsonb,boolean) owner to vortex_owner;


alter function vortex_record.create_system_projection_companion_storage_internal(uuid,uuid,uuid,uuid,jsonb,boolean)
  owner to vortex_owner;

revoke all on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean)
  to vortex_owner;
comment on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean) is
  'Privately preflights or provisions one optional unindexed companion field for an exact system-projection storage contract. Companion rows are organisation-scoped and are never written by a separate Record command.';

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
  contribution_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
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

alter function vortex_record.provision_exact_module_contributions(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb) is
  'Private exact-release contributor storage provisioner: adds generated-table fields or optional unindexed system-projection companion fields and records their retained lineage. It never drops a column, changes projection identity, or overwrites a value.';

create or replace function vortex_access.list_organization_group_memberships_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Membership projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'membership.starts_at'
    when 'expires_at' then 'membership.expires_at'
    when 'state' then 'membership.state'
    else 'membership.membership_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'nullable_time' then
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s nulls %s, membership.membership_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind = 'text' then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, membership.membership_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, membership.membership_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or (pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
          and (sort_kind <> 'nullable_time'
            or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'null'))
      )) then
      raise exception using errcode = '22023', message = 'Membership projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind in ('time', 'nullable_time') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Membership projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and membership.membership_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'text' then
      keyset_sql := pg_catalog.format(' and (%s, membership.membership_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and ((%1$s is null and (%2$s is not null or (%2$s is null and membership.membership_id > $4)))'
          || ' or (%1$s is not null and (%2$s, membership.membership_id) > (%3$s, $4)))'
        else
        ' and ((%1$s is null and %2$s is null and membership.membership_id < $4)'
          || ' or (%1$s is not null and (%2$s is null or (%2$s, membership.membership_id) < (%3$s, $4))))'
        end,
        '$5',
        sort_expression,
        '$5');
    else
      keyset_sql := pg_catalog.format(' and (%s, membership.membership_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "group_id": {"sql": "membership.group_id::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "membership.organization_account_id::text", "database": "text", "filter": true},
      "state": {"sql": "membership.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when membership.state = 'revoked' then 'revoked' when membership.starts_at > $7 then 'scheduled' when membership.expires_at is not null and membership.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "account_display_name": {"sql": "account.display_name", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the account of a membership; the final select
    -- joins it the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_groups_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select membership.membership_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_group_memberships as membership
      %s
      where membership.organization_id = $1
        and ($2 is null or membership.membership_id = any($2))
      %s
      order by %s limit $6
    )
    select membership.organization_id, membership.membership_id, membership.revision,
      pg_catalog.jsonb_build_object(
      'group_id', membership.group_id,
      'organization_account_id', membership.organization_account_id,
      'account_display_name', account.display_name,
      'starts_at', membership.starts_at,
      'expires_at', membership.expires_at,
      'state', membership.state,
      'temporal_state', case
        when membership.state = 'revoked' then 'revoked'
        when membership.starts_at > $7 then 'scheduled'
        when membership.expires_at is not null and membership.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = $1 and membership.membership_id = candidate.record_id
    join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_group_memberships_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_access.list_organization_role_assignments_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Assignment projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'assignment.starts_at'
    when 'expires_at' then 'assignment.expires_at'
    when 'state' then 'assignment.state'
    else 'assignment.role_assignment_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'nullable_time' then
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s nulls %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind = 'text' then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, assignment.role_assignment_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or (pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
          and (sort_kind <> 'nullable_time'
            or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'null'))
      )) then
      raise exception using errcode = '22023', message = 'Assignment projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind in ('time', 'nullable_time') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Assignment projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and assignment.role_assignment_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'text' then
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and (($5 is null and (assignment.expires_at is not null or (assignment.expires_at is null and assignment.role_assignment_id > $4)))'
          || ' or ($5 is not null and (assignment.expires_at, assignment.role_assignment_id) > ($5, $4)))'
        else
        ' and (($5 is null and assignment.expires_at is null and assignment.role_assignment_id < $4)'
          || ' or ($5 is not null and (assignment.expires_at is null or (assignment.expires_at, assignment.role_assignment_id) < ($5, $4))))'
        end);
    else
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "role_id": {"sql": "assignment.role_id::text", "database": "text", "filter": true},
      "assignee_kind": {"sql": "assignment.assignee_kind::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "assignment.organization_account_id::text", "database": "text", "filter": true},
      "group_id": {"sql": "assignment.group_id::text", "database": "text", "filter": true},
      "assignment_kind": {"sql": "assignment.assignment_kind::text", "database": "text", "filter": true},
      "state": {"sql": "assignment.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when assignment.state = 'revoked' then 'revoked' when assignment.starts_at > $7 then 'scheduled' when assignment.expires_at is not null and assignment.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "role_key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "role_label": {"sql": "role_revision.label", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the role of an assignment; the final select
    -- joins it the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select assignment.role_assignment_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_role_assignments as assignment
      %s
      where assignment.organization_id = $1
        and ($2 is null or assignment.role_assignment_id = any($2))
      %s
      order by %s limit $6
    )
    select assignment.organization_id, assignment.role_assignment_id, assignment.revision,
      pg_catalog.jsonb_build_object(
      'role_id', assignment.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'assignee_kind', assignment.assignee_kind,
      'organization_account_id', assignment.organization_account_id,
      'group_id', assignment.group_id,
      'assignment_kind', assignment.assignment_kind,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', assignment.state,
      'temporal_state', case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > $7 then 'scheduled'
        when assignment.expires_at is not null and assignment.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = $1 and assignment.role_assignment_id = candidate.record_id
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_access.list_organization_role_activations_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'activated_at', 'expires_at', 'state')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Activation projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'activated_at' then 'activation.activated_at'
    when 'expires_at' then 'activation.expires_at'
    when 'state' then 'activation.state'
    else 'activation.role_activation_id' end;
  sort_kind := case p_sort_key
    when 'activated_at' then 'time'
    when 'expires_at' then 'time'
    when 'state' then 'text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'text' then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, activation.role_activation_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, activation.role_activation_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Activation projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind = 'time' then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activation projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and activation.role_activation_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'text' then
      keyset_sql := pg_catalog.format(' and (%s, activation.role_activation_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    else
      keyset_sql := pg_catalog.format(' and (%s, activation.role_activation_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "organization_account_id": {"sql": "activation.organization_account_id::text", "database": "text", "filter": true},
      "role_id": {"sql": "activation.role_id::text", "database": "text", "filter": true},
      "eligibility_source_kind": {"sql": "activation.eligibility_source_kind::text", "database": "text", "filter": true},
      "state": {"sql": "activation.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when activation.state = 'revoked' then 'revoked' when activation.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "account_display_name": {"sql": "account.display_name", "database": "text", "filter": true, "search": true},
      "role_key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "role_label": {"sql": "role_revision.label", "database": "text", "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the account and role of an activation; the final
    -- select joins them the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_identity.organization_accounts as account
      on account.organization_id = activation.organization_id
      and account.organization_account_id = activation.organization_account_id
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select activation.role_activation_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_role_activations as activation
      %s
      where activation.organization_id = $1
        and ($2 is null or activation.role_activation_id = any($2))
      %s
      order by %s limit $6
    )
    select activation.organization_id, activation.role_activation_id, activation.revision,
      pg_catalog.jsonb_build_object(
      'organization_account_id', activation.organization_account_id,
      'account_display_name', account.display_name,
      'role_id', activation.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'eligibility_source_kind', activation.eligibility_source_kind,
      'activated_at', activation.activated_at,
      'expires_at', activation.expires_at,
      'state', activation.state,
      'temporal_state', case
        when activation.state = 'revoked' then 'revoked'
        when activation.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = $1 and activation.role_activation_id = candidate.record_id
    join vortex_identity.organization_accounts as account
      on account.organization_id = activation.organization_id
      and account.organization_account_id = activation.organization_account_id
    join vortex_access.organization_roles as role
      on role.organization_id = activation.organization_id and role.role_id = activation.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_role_activations_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_record.run_module_query_summary_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_inputs jsonb,
  p_prepared_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  summary_candidate_limit constant integer := 100000;
  group_page_default constant integer := 40;
  group_page_maximum constant integer := 200;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb := p_prepared_plan;
  user_search text := nullif(pg_catalog.btrim(p_user_inputs ->> 'search'), '');
  search_field_ids text[] := array[]::text[];
  declared_searchable_ids jsonb := coalesce(p_user_inputs -> 'searchableFieldIds', '[]'::jsonb);
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  v_storage_contract_id uuid;
  physical_table_token text;
  storage_scope text;
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  readable_field_ids text[] := array[]::text[];
  bound_field_ids text[] := array[]::text[];
  filter_condition jsonb;
  filter_types jsonb := '{}'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  filter_ids text[] := array[]::text[];
  filter_predicate text := 'true';
  filter_parameters jsonb := '[]'::jsonb;
  filter_expression_pairs text[] := array[]::text[];
  filter_values_sql text := '''{}''::jsonb';
  group_ids text[] := array[]::text[];
  aggregate_items jsonb := '[]'::jsonb;
  aggregate_item jsonb;
  aggregate_aliases text[] := array[]::text[];
  summary_field_ids text[] := array[]::text[];
  fast_field_ids text[] := array[]::text[];
  fields_by_id jsonb := '{}'::jsonb;
  field_item jsonb;
  field_key text;
  field_type text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  fast_path boolean := false;
  fast_path_fields_valid boolean := true;
  search_prefilter_sql text := 'true';
  scan_sql text;
  candidate_sql text;
  selected_sql text;
  summary_sql text;
  expression_pairs text[] := array[]::text[];
  group_value_pairs text[] := array[]::text[];
  group_by_terms text[] := array[]::text[];
  group_presence_terms text[] := array[]::text[];
  group_values_sql text;
  group_value_sql text;
  group_page_limit integer;
  group_after text := p_user_inputs ->> 'groupAfter';
  pivot_mode boolean := false;
  group_cursor jsonb;
  pivot_row_field_id text;
  pivot_column_field_id text;
  pivot_measure_field_id text;
  pivot_buckets jsonb := '{}'::jsonb;
  group_bucket jsonb;
  pivot_column_limit constant integer := 50;
  group_presence_sql text;
  group_dimension_sql text;
  group_axis_ctes_sql text;
  group_axis_joins_sql text := '';
  group_axis_index integer := 0;
  group_field_type text;
  group_axis_normalized text;
  group_axis_rank text;
  group_axis_title text;
  group_first_rank_sql text;
  group_axis_normalized_pairs text[] := array[]::text[];
  group_axis_title_terms text[] := array[]::text[];
  aggregate_object_sql text := '';
  summary_totals_sql text;
  aggregate_result_sql text;
  aggregate_count_sql text;
  aggregate_sum_sql text;
  aggregate_average_sql text;
  aggregate_present_sql text;
  aggregate_value_sql text;
  aggregate_currency_sql text;
  aggregate_amount_sql text;
  aggregate_mixed_currency_sql text;
  aggregate_operation text;
  aggregate_field_id text;
  aggregate_field_type text;
  aggregate_original_field_type text;
  aggregate_alias text;
  average_places integer;
  value_expression text;
  groups_json_sql text := '''[]''::jsonb';
  board_summary_mode boolean := false;
  board_choice_field_id text;
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_bucket_sql text;
  board_requested_columns jsonb := p_user_inputs #> '{boardSummary,columns}';
  board_requested_positions integer[] := array[]::integer[];
  board_requested_column jsonb;
  board_option_position integer;
  board_totals_sql text;
  board_empty_aggregates_sql text;
  result_value jsonb;
  error_message text;
begin
  board_summary_mode := p_user_inputs ? 'boardSummary';
  if board_summary_mode then
    board_choice_field_id := pg_catalog.lower(p_user_inputs #>> '{boardSummary,choiceFieldId}');
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  if record_type_item ? 'systemProjection' then
    -- A protected reader supplies bounded pages, not an unbounded relation
    -- for aggregate scans.
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;

  if p_user_inputs ? 'grouping' then
    query_item := vortex_record.grouping_query_internal(
      query_item, record_type_item, p_user_inputs -> 'grouping', 50
    );
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;
  pivot_mode := p_user_inputs ? 'pivot';
  if pivot_mode then
    query_item := vortex_record.pivot_query_internal(
      query_item, record_type_item, p_user_inputs -> 'pivot'
    );
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    pivot_row_field_id := pg_catalog.lower(p_user_inputs #>> '{pivot,rowFieldId}');
    pivot_column_field_id := pg_catalog.lower(p_user_inputs #>> '{pivot,columnFieldId}');
    pivot_measure_field_id := pg_catalog.lower(p_user_inputs #>> '{pivot,measure,fieldId}');
    pivot_buckets := pg_catalog.jsonb_build_object(
      pivot_row_field_id, p_user_inputs #> '{pivot,rowDateBucket}',
      pivot_column_field_id, p_user_inputs #> '{pivot,columnDateBucket}'
    );
  elsif p_user_inputs ? 'grouping' then
    pivot_buckets := pg_catalog.jsonb_build_object(
      pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}'), p_user_inputs #> '{grouping,dateBucket}'
    );
  end if;
  -- A group continuation is the jsonb text [rank, title, canonical group value] of the last group
  -- a page returned, for pivot rows and grouped tables alike; anything else is forged.
  if group_after is not null then
    begin
      group_cursor := group_after::jsonb;
      if pg_catalog.jsonb_typeof(group_cursor) <> 'array'
        or pg_catalog.jsonb_array_length(group_cursor) <> 3
        or (group_cursor ->> 0) not in ('0', '1', '2')
        or pg_catalog.jsonb_typeof(group_cursor -> 0) <> 'number'
        or pg_catalog.jsonb_typeof(group_cursor -> 1) <> 'string'
        or pg_catalog.jsonb_typeof(group_cursor -> 2) <> 'string' then
        raise exception using errcode = '22023', message = 'Group cursor is not a group key';
      end if;
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end;
  end if;
  -- Every grouped read pages its groups: the requested page size, or the default, held to the maximum.
  -- The candidate ceiling bounds the rows a read may scan, never the groups it returns.
  group_page_limit := least(group_page_maximum, greatest(1, coalesce(case
    when pivot_mode then ((p_user_inputs #>> '{pivot,rowLimit}')::numeric)::integer
    when p_user_inputs ? 'grouping' then ((p_user_inputs #>> '{grouping,limit}')::numeric)::integer
    when p_user_inputs ? 'groupLimit' then ((p_user_inputs ->> 'groupLimit')::numeric)::integer
    end, group_page_default)));
  if pg_catalog.jsonb_typeof(declared_searchable_ids) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(declared_searchable_ids) > 200 or exists (
    select 1 from pg_catalog.jsonb_array_elements(declared_searchable_ids) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'string' or pg_catalog.lower(item.value #>> '{}') !~ uuid_pattern
  ) or (select pg_catalog.count(*) <> pg_catalog.count(distinct pg_catalog.lower(item.value #>> '{}'))
        from pg_catalog.jsonb_array_elements(declared_searchable_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 10
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if board_summary_mode
    and pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'fields', '[]'::jsonb)) as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  select coalesce(pg_catalog.array_agg(field.key), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_each(fields_by_id) as field(key, value)
  where field.value ->> 'searchPriority' in ('first', 'normal', 'last')
    and (pg_catalog.jsonb_array_length(declared_searchable_ids) = 0 or exists (
      select 1 from pg_catalog.jsonb_array_elements_text(declared_searchable_ids) as selected(id)
      where pg_catalog.lower(selected.id) = field.key
    ));

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    field_key := pg_catalog.lower(field_item #>> '{}');
    field_type := coalesce(fields_by_id -> field_key ->> 'type', '');
    if field_key = any (group_ids)
      or field_type not in (
        'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
        'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
        'link'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    group_ids := pg_catalog.array_append(group_ids, field_key);
    if not (field_key = any (summary_field_ids)) then
      summary_field_ids := pg_catalog.array_append(summary_field_ids, field_key);
      fast_field_ids := pg_catalog.array_append(fast_field_ids, field_key);
    end if;
  end loop;

  if board_summary_mode then
    if pg_catalog.cardinality(group_ids) <> 1
      or group_ids[1] is distinct from board_choice_field_id
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true
      or pg_catalog.jsonb_typeof(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) is distinct from 'array'
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) as selected(value)
        where pg_catalog.jsonb_typeof(selected.value) = 'string'
          and pg_catalog.lower(selected.value #>> '{}') = board_choice_field_id
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
  end if;

  aggregate_items := coalesce(query_item -> 'aggregates', '[]'::jsonb);
  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    if aggregate_operation not in ('count', 'sum', 'minimum', 'maximum', 'average', 'distinct_count')
      or aggregate_alias is null
      or aggregate_alias !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or pg_catalog.length(aggregate_alias) > 40
      or aggregate_alias = any (aggregate_aliases)
      or (aggregate_item ? 'fieldId' and aggregate_field_id is null)
      or (aggregate_operation <> 'count' and aggregate_field_id is null)
      or (aggregate_operation = 'count' and aggregate_field_id is not null) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    aggregate_aliases := pg_catalog.array_append(aggregate_aliases, aggregate_alias);
    if aggregate_field_id is not null then
      if aggregate_field_id !~ uuid_pattern or not (fields_by_id ? aggregate_field_id) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_operation = 'distinct_count'
        and (fields_by_id -> aggregate_field_id ->> 'filterable')::boolean is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if aggregate_original_field_type = 'calculation' then
        if (fields_by_id -> aggregate_field_id) #>> '{settings,expression,kind}' is distinct from 'numeric'
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if (aggregate_operation in ('sum', 'average')
          and aggregate_field_type not in ('whole_number', 'decimal_number', 'money'))
        or (aggregate_operation in ('minimum', 'maximum')
          and aggregate_field_type not in (
            'text', 'whole_number', 'decimal_number', 'yes_no', 'money', 'date', 'date_time'
          )) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if not (aggregate_field_id = any (summary_field_ids)) then
        summary_field_ids := pg_catalog.array_append(summary_field_ids, aggregate_field_id);
        fast_field_ids := pg_catalog.array_append(fast_field_ids, aggregate_field_id);
      end if;
    end if;
  end loop;

  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := coalesce(prepared_plan #>> '{access,predicate}', 'true');
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  -- The fields the reader is guaranteed to see on every record it may read: the bound a grouped
  -- table offers its filter, search and sort controls by, as a plain page read reports it.
  select coalesce(pg_catalog.array_agg(item.value order by item.value), array[]::text[])
  into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'fieldBoundIds') as item(value)
  where fields_by_id ? item.value;
  if p_user_inputs ? 'grouping' and not (
    pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}') = any (readable_field_ids)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  -- A pivot axis or measure withheld from the viewer on any record is refused, so a withheld
  -- value never appears as a row, a column or a measure.
  if pivot_mode and not (
    pivot_row_field_id = any (readable_field_ids)
    and pivot_column_field_id = any (readable_field_ids)
    and (pivot_measure_field_id is null or pivot_measure_field_id = any (readable_field_ids))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  -- The compiler already applied an exact predicate over guaranteed readable
  -- columns. Re-evaluating it for each selected row adds no decision.
  if (prepared_plan #>> '{filter,pushedExact}')::boolean is true then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value order by item.position), array[]::text[])
  into filter_expression_pairs
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}')
    with ordinality as item(value, position);
  if pg_catalog.cardinality(filter_expression_pairs) > 0 then
    select pg_catalog.string_agg(
      'pg_catalog.jsonb_build_object(' || chunk.pairs_text || ')', ' || '
      order by chunk.chunk_index
    )
    into filter_values_sql
    from (
      select (pair.position - 1) / 50 as chunk_index,
        pg_catalog.string_agg(pair.value, ', ' order by pair.position) as pairs_text
      from pg_catalog.unnest(filter_expression_pairs)
        with ordinality as pair(value, position)
      group by (pair.position - 1) / 50
    ) as chunk;
  end if;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);

  -- The plan is exact only when every candidate is readable and every field
  -- used by grouping, aggregates or filtering is readable on every candidate.
  -- Derived filter and aggregate fields can lose their projection on an
  -- individual record when an input is withheld, so both require read_record.
  -- A search may match through a field readable on only some records; read_record
  -- remains authoritative for each match rather than searching hidden stored values.
  fast_path := user_search is null and pg_catalog.cardinality(readable_field_ids) > 0
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as required(id)
      where fields_by_id -> required.id ->> 'type' in ('calculation', 'total')
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and fields_by_id -> pg_catalog.lower(item.value ->> 'fieldId') ->> 'type'
          in ('calculation', 'total')
    )
    and not exists (
      select 1 from pg_catalog.unnest(group_ids || filter_ids) as required(id)
      where required.id <> all (readable_field_ids)
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and pg_catalog.lower(item.value ->> 'fieldId') <> all (readable_field_ids)
    );

  if fast_path then
    foreach field_key in array fast_field_ids loop
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        fast_path_fields_valid := false;
        exit;
      end if;
      field_type := fields_by_id -> field_key ->> 'type';
      fast_path_fields_valid := fast_path_fields_valid and case field_type
        when 'whole_number' then mapping_row.database_value_type = 'integer'
        when 'decimal_number' then mapping_row.database_value_type = 'decimal'
        when 'yes_no' then mapping_row.database_value_type = 'boolean'
        when 'date' then mapping_row.database_value_type = 'date'
        when 'date_time' then mapping_row.database_value_type = 'timestamp_with_time_zone'
        when 'money' then mapping_row.database_value_type = 'json'
        when 'link' then mapping_row.database_value_type = 'json'
        when 'link_to_one_of_several' then mapping_row.database_value_type = 'json'
        when 'text' then mapping_row.database_value_type = 'text'
        when 'long_text' then mapping_row.database_value_type = 'text'
        when 'formatted_text' then mapping_row.database_value_type = 'json'
        when 'choice' then mapping_row.database_value_type = 'text'
        when 'reference_number' then mapping_row.database_value_type = 'text'
        when 'email_address' then mapping_row.database_value_type = 'text'
        when 'phone_number' then mapping_row.database_value_type = 'text'
        when 'web_address' then mapping_row.database_value_type = 'text'
        when 'several_choices' then mapping_row.database_value_type = 'json'
        when 'table' then mapping_row.database_value_type = 'json'
        when 'attachment' then mapping_row.database_value_type = 'json'
        else false end;
      if not fast_path_fields_valid then
        exit;
      end if;
      value_expression := case mapping_row.database_value_type
        when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
        when 'timestamp_with_time_zone' then pg_catalog.format(
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
          mapping_row.physical_column_token
        )
        when 'date' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
          mapping_row.physical_column_token
        )
        else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
      end;
      expression_pairs := pg_catalog.array_append(
        expression_pairs, pg_catalog.format('%L, %s', field_key, value_expression)
      );
    end loop;
    fast_path := fast_path_fields_valid;
  end if;

  -- A search narrows the candidate scan, and so the ceiling, through the one shared
  -- stored-value pre-predicate; read_record stays the decision for each counted match.
  search_prefilter_sql := vortex_record.query_search_prefilter_internal(
    v_storage_contract_id, fields_by_id, search_field_ids, readable_field_ids, user_search, 18, 19
  );

  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    aggregate_count_sql := 'pg_catalog.count(*)';
    aggregate_present_sql := 'true';
    aggregate_value_sql := 'pg_catalog.to_jsonb(pg_catalog.count(*))';
    aggregate_mixed_currency_sql := 'false';
    if aggregate_field_id is not null then
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_original_field_type = 'calculation' then
        if (fields_by_id -> aggregate_field_id) #>> '{settings,expression,kind}' is distinct from 'numeric'
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_present_sql := pg_catalog.format(
        '(candidate.projected_values ? %L and candidate.projected_values -> %L <> ''null''::jsonb)',
        aggregate_field_id, aggregate_field_id
      );
      aggregate_count_sql := pg_catalog.format(
        'pg_catalog.count(*) filter (where %s)', aggregate_present_sql
      );
      value_expression := pg_catalog.format('(candidate.projected_values -> %L)', aggregate_field_id);
      aggregate_currency_sql := pg_catalog.format(
        '(candidate.projected_values -> %L ->> ''currency'')', aggregate_field_id
      );
      aggregate_amount_sql := pg_catalog.format(
        '((candidate.projected_values -> %L ->> ''amount'')::numeric)', aggregate_field_id
      );
      if aggregate_operation = 'count' then
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', aggregate_count_sql);
      elsif aggregate_operation = 'distinct_count' then
        -- SQL numeric equality folds differently scaled exact decimal text. Money
        -- includes its currency; counting different values never adds currencies.
        value_expression := case aggregate_field_type
          when 'decimal_number' then pg_catalog.format(
            'pg_catalog.to_jsonb((candidate.projected_values ->> %L)::numeric)', aggregate_field_id)
          when 'money' then pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', %s)',
            aggregate_amount_sql, aggregate_currency_sql)
          else value_expression end;
        aggregate_value_sql := pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.count(distinct %s) filter (where %s))',
          value_expression, aggregate_present_sql
        );
      elsif aggregate_field_type = 'money' then
        aggregate_mixed_currency_sql := pg_catalog.format(
          '(pg_catalog.count(distinct %s) filter (where %s)) > 1',
          aggregate_currency_sql, aggregate_present_sql
        );
        if aggregate_operation = 'minimum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s asc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        elsif aggregate_operation = 'maximum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s desc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        else
          average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
          if average_places not between 0 and 12 then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
          end if;
          if aggregate_operation = 'sum' then
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale(pg_catalog.sum(%s) filter (where %s))::text',
              aggregate_amount_sql, aggregate_present_sql
            );
          else
            aggregate_sum_sql := pg_catalog.format(
              'pg_catalog.sum(%s) filter (where %s)', aggregate_amount_sql, aggregate_present_sql
            );
            aggregate_average_sql := pg_catalog.format(
              'case when %3$s = 0 then null else
                 pg_catalog.sign(%1$s) * (
                   pg_catalog.div(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   )
                   + case when 2 * pg_catalog.mod(
                       pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                       (%3$s)::numeric
                     ) >= (%3$s)::numeric then 1 else 0 end
                 ) / pg_catalog.power(10::numeric, %2$s)
               end',
              aggregate_sum_sql, average_places, aggregate_count_sql
            );
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
            );
          end if;
          aggregate_value_sql := pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', (pg_catalog.array_agg(%s order by %s collate "C" asc) filter (where %s))[1])',
            value_expression, aggregate_currency_sql, aggregate_currency_sql, aggregate_present_sql
          );
        end if;
      elsif aggregate_operation in ('minimum', 'maximum') then
        if aggregate_field_type = 'text' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L) collate "C" %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'yes_no' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L)::boolean %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'whole_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s((candidate.projected_values ->> %L)::bigint) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'decimal_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.trim_scale(pg_catalog.%s((candidate.projected_values ->> %L)::numeric) filter (where %s))::text)',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'date' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s(candidate.projected_values ->> %L) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        else
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(pg_catalog.%s((candidate.projected_values ->> %L)::timestamp with time zone) filter (where %s)))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        end if;
        aggregate_value_sql := value_expression;
      else
        average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
        if aggregate_operation = 'average' and average_places not between 0 and 12 then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        if aggregate_operation = 'sum' then
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale(pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s))::text',
            aggregate_field_id, aggregate_present_sql
          );
        else
          aggregate_sum_sql := pg_catalog.format(
            'pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s)',
            aggregate_field_id, aggregate_present_sql
          );
          aggregate_average_sql := pg_catalog.format(
            'case when %3$s = 0 then null else
               pg_catalog.sign(%1$s) * (
                 pg_catalog.div(
                   pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                   (%3$s)::numeric
                 )
                 + case when 2 * pg_catalog.mod(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   ) >= (%3$s)::numeric then 1 else 0 end
               ) / pg_catalog.power(10::numeric, %2$s)
             end',
            aggregate_sum_sql, average_places, aggregate_count_sql
          );
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
          );
        end if;
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', value_expression);
      end if;
      if aggregate_operation in ('count', 'distinct_count') then
        aggregate_result_sql := pg_catalog.format(
          'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', %s)',
          aggregate_count_sql, aggregate_value_sql
        );
      else
        aggregate_result_sql := pg_catalog.format(
          'case when %s then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''mixed_currency'') else pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', case when %s = 0 then ''null''::jsonb else %s end) end',
          aggregate_mixed_currency_sql, aggregate_count_sql, aggregate_count_sql, aggregate_value_sql
        );
      end if;
    else
      aggregate_result_sql := pg_catalog.format(
        'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', pg_catalog.count(*), ''value'', pg_catalog.to_jsonb(pg_catalog.count(*)))'
      );
    end if;
    -- A missing projected key is withheld, whereas a readable empty field remains JSON null.
    -- Never present a partial total (or an empty total) as the aggregate of the whole bucket.
    if aggregate_field_id is not null then
      aggregate_result_sql := pg_catalog.format(
        'case when coalesce(pg_catalog.bool_or(not (candidate.projected_values ? %L)), false)
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''read_forbidden'')
           else %s end',
        aggregate_field_id, aggregate_result_sql
      );
    end if;
    if aggregate_object_sql <> '' then
      aggregate_object_sql := aggregate_object_sql || ', ';
    end if;
    aggregate_object_sql := aggregate_object_sql || pg_catalog.format('%L, %s', aggregate_alias, aggregate_result_sql);
  end loop;

  -- A count-only grouping has no authored aggregate expressions. Its totals
  -- must still be exactly one row when the selection is empty or over budget.
  summary_totals_sql := case when aggregate_object_sql = '' then
    'select ''{}''::jsonb as aggregate_values'
    else pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as aggregate_values from selected as candidate',
      aggregate_object_sql) end;

  foreach field_key in array group_ids loop
    group_bucket := nullif(pivot_buckets -> field_key, 'null'::jsonb);
    group_value_sql := pg_catalog.format(
      'vortex_record.grouping_value_internal(candidate.projected_values -> %L, %L, %L::jsonb)',
      field_key, fields_by_id -> field_key ->> 'type', group_bucket::text
    );
    group_value_pairs := pg_catalog.array_append(
      group_value_pairs, pg_catalog.format('%L, %s', field_key, group_value_sql)
    );
    group_by_terms := pg_catalog.array_append(group_by_terms, group_value_sql);
    group_presence_terms := pg_catalog.array_append(
      group_presence_terms, pg_catalog.format('(candidate.projected_values ? %L)', field_key)
    );
  end loop;
  group_values_sql := 'pg_catalog.jsonb_build_object(' || pg_catalog.array_to_string(group_value_pairs, ', ') || ')';
  group_presence_sql := pg_catalog.array_to_string(group_presence_terms, ' and ');
  -- A grouped table orders its groups by the tuple of (rank, title) per group field, in
  -- groupByFieldIds order, then the canonical value. A link dimension takes its rank and title from
  -- one protected title batch per link field (the batch pivot axes use), so unreadable targets fold
  -- into one Not available value per field. A choice dimension follows the field's option order: a
  -- stored value the field no longer offers follows every option, and no value comes last (rank 1,
  -- as for a link). Every other dimension keeps its canonical value order. The first field's rank is
  -- the group's rank; every field's title (terminated, the later ones led by their rank) is the
  -- group's title, so the keyset cursor stays [rank, title, canonical value].
  group_axis_ctes_sql := '';
  foreach field_key in array group_ids loop
    group_axis_index := group_axis_index + 1;
    group_field_type := fields_by_id -> field_key ->> 'type';
    if group_field_type = 'link' then
      group_axis_ctes_sql := group_axis_ctes_sql || pg_catalog.format(
        'link_axis_%1$s as materialized (
           select * from vortex_record.dimension_value_internal(
             (select pg_catalog.array_agg(distinct raw.group_values -> %2$L) from raw_dimensions as raw), %3$L::jsonb
           )
         ), ',
        group_axis_index, field_key, (fields_by_id -> field_key)::text
      );
      group_axis_joins_sql := group_axis_joins_sql || pg_catalog.format(
        ' left join link_axis_%1$s on link_axis_%1$s.value = raw.group_values -> %2$L',
        group_axis_index, field_key
      );
      group_axis_normalized := pg_catalog.format('link_axis_%s.normalized', group_axis_index);
      group_axis_rank := pg_catalog.format('coalesce(link_axis_%s.sort_rank, 0)', group_axis_index);
      group_axis_title := pg_catalog.format('coalesce(link_axis_%s.sort_title, '''')', group_axis_index);
    elsif group_field_type = 'choice' then
      group_axis_normalized := pg_catalog.format('raw.group_values -> %L', field_key);
      group_axis_rank := pg_catalog.format(
        'case when coalesce(raw.group_values -> %L, ''null''::jsonb) = ''null''::jsonb then 1 else 0 end', field_key
      );
      group_axis_title := pg_catalog.format(
        'case when coalesce(raw.group_values -> %1$L, ''null''::jsonb) = ''null''::jsonb then ''''::text
           else coalesce((
             select pg_catalog.lpad(choice_option.ordinal::text, 4, ''0'')
             from pg_catalog.jsonb_array_elements(%2$L::jsonb) with ordinality as choice_option(item, ordinal)
             where choice_option.item ->> ''value'' = raw.group_values ->> %1$L
             order by choice_option.ordinal limit 1
           ), ''9999'') end',
        field_key, coalesce(fields_by_id #> array[field_key, 'settings', 'options'], '[]'::jsonb)::text
      );
    else
      group_axis_normalized := pg_catalog.format('raw.group_values -> %L', field_key);
      group_axis_rank := '0';
      group_axis_title := '''''::text';
    end if;
    group_axis_normalized_pairs := pg_catalog.array_append(
      group_axis_normalized_pairs, pg_catalog.format('%L, %s', field_key, group_axis_normalized)
    );
    group_axis_title_terms := pg_catalog.array_append(
      group_axis_title_terms,
      case when group_axis_index = 1 then '' else '(' || group_axis_rank || ')::text || ' end
        || pg_catalog.format('pg_catalog.translate(pg_catalog.left(%s, 256), pg_catalog.chr(1), '''') || pg_catalog.chr(1)', group_axis_title)
    );
    if group_axis_index = 1 then group_first_rank_sql := group_axis_rank; end if;
  end loop;
  group_dimension_sql := pg_catalog.format(
    'select raw.group_values as value, pg_catalog.jsonb_build_object(%s) as normalized,
       %s as sort_rank, %s as sort_title
     from (select distinct group_values from raw_dimensions) as raw%s',
    pg_catalog.array_to_string(group_axis_normalized_pairs, ', '),
    group_first_rank_sql,
    pg_catalog.array_to_string(group_axis_title_terms, ' || '),
    group_axis_joins_sql
  );

  if fast_path then
    candidate_sql := pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as projected_values,
         %s as filter_values
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
       limit $5',
      pg_catalog.array_to_string(expression_pairs, ', '),
      filter_values_sql,
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate
    );
  else
    -- The access predicate supplies only the planner's candidate superset.
    -- Decide every scanned row through read_record before evaluating its Query
    -- filter, so a withheld field can never decide whether it counts.
    scan_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
         and (%s)
       limit $5',
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate,
      search_prefilter_sql
    );
    candidate_sql := scan_sql;
  end if;

  -- A compiled predicate may be a superset. The fast path still evaluates the
  -- complete condition over values the exact plan proves readable; the raw
  -- candidate count remains the ceiling, before any totals are returned.
  if fast_path then
    selected_sql := case when filter_condition is not null then
      'select candidate.projected_values from candidate where
         vortex_access.evaluate_query_condition_internal(
           $12, $13, candidate.filter_values, $14, $15, false
         )'
      else 'select candidate.projected_values from candidate' end;
  else
    -- Decide the candidates together, one set pass per batch, and materialize each read once.
    -- The raw candidate count gates the reads, and every filter and aggregate uses only the
    -- fields this read returned.
    selected_sql := pg_catalog.format(
      'with readable as materialized (
         select batch.result
         from vortex_record.read_record_batch_internal(
           %L::uuid,
           (select pg_catalog.array_agg(candidate.record_id) from candidate
             where (select value from candidate_count) <= %s),
           %L::boolean, %L::uuid, %L::jsonb
         ) as batch
       )
       select (
         select coalesce(pg_catalog.jsonb_object_agg(field.id, readable.result -> ''values'' -> field.id), ''{}''::jsonb)
         from pg_catalog.unnest($17::text[]) as field(id)
         where readable.result -> ''values'' ? field.id
       ) as projected_values
       from readable
       where readable.result ->> ''outcome'' = ''allowed''
         and vortex_record.query_search_matches_internal(readable.result -> ''values'', $18::text[], $19::text)
         and not exists (
           select 1 from pg_catalog.unnest($16::text[]) as required(id)
           where not (readable.result -> ''values'' ? required.id)
         )
         and ($12::jsonb is null or vortex_access.evaluate_query_condition_internal(
           $12, $13,
           (select coalesce(pg_catalog.jsonb_object_agg(referenced.id,
             case $13 ->> referenced.id
               when ''organization_account_reference'' then pg_catalog.to_jsonb(
                 pg_catalog.lower(readable.result -> ''values'' -> referenced.id ->> ''organizationAccountId''))
               else readable.result -> ''values'' -> referenced.id
             end), ''{}''::jsonb)
            from pg_catalog.unnest($16::text[]) as referenced(id)),
           $14, $15, false
         ))',
      record_type_id_value::text, summary_candidate_limit,
      prepared_plan ? 'preview', v_storage_contract_id::text,
      case when prepared_plan ? 'preview' then record_type_item::text end
    );
  end if;

  -- Omitted grouping fields are withheld on that row, so they form no group;
  -- a readable JSON null remains a legitimate null group.
  if board_summary_mode then
    board_bucket_sql := pg_catalog.format(
      'case when pg_catalog.jsonb_typeof(candidate.projected_values -> %L) = ''string'' then case ',
      board_choice_field_id
    );
    board_option_position := 0;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      board_option_position := board_option_position + 1;
      board_bucket_sql := board_bucket_sql || pg_catalog.format(
        'when (candidate.projected_values ->> %L) collate "C" = %L collate "C" then %s ',
        board_choice_field_id, board_option ->> 'value', board_option_position
      );
    end loop;
    board_bucket_sql := board_bucket_sql || 'else 0 end else 0 end';
    -- Requested buckets are data, validated against the installed options. Only these buckets
    -- enter the existing capped aggregate path; unread columns retain navigation metadata only.
    for board_requested_column in
      select item.value from pg_catalog.jsonb_array_elements(board_requested_columns) as item(value)
    loop
      if board_requested_column ->> 'kind' = 'unassigned' then
        board_requested_positions := pg_catalog.array_append(board_requested_positions, 0);
      else
        board_option_position := pg_catalog.array_position(board_option_values, board_requested_column ->> 'value');
        if board_option_position is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        board_requested_positions := pg_catalog.array_append(board_requested_positions, board_option_position);
      end if;
    end loop;

    if aggregate_object_sql = '' then
      board_totals_sql := 'select ''{}''::jsonb as aggregate_values';
      board_empty_aggregates_sql := 'select ''{}''::jsonb as aggregates';
    else
      board_totals_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) as aggregate_values
         from normalized as candidate',
        aggregate_object_sql
      );
      board_empty_aggregates_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) as aggregates
         from (select null::jsonb as projected_values) as candidate where false',
        aggregate_object_sql
      );
    end if;
    if fast_path then
      -- One grouping-set scan computes both each bucket and the grand total.
      -- The raw candidate count is retained separately for the existing limit.
      summary_sql := pg_catalog.format(
        'with candidate as materialized (%s),
         candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
         selected as (%s),
         normalized as (
           select bucket.projected_values, bucket.bucket_index
           from (select candidate.projected_values, %s as bucket_index
             from selected as candidate) as bucket
           where bucket.bucket_index = any (%L::integer[])
         ),
         aggregate_rows as materialized (
           select grouping(candidate.bucket_index) as is_total,
             candidate.bucket_index,
             pg_catalog.count(*)::integer as row_count,
             %s as aggregates
           from normalized as candidate
           group by rollup(candidate.bucket_index)
         ),
         totals as (select row_count, aggregates from aggregate_rows where is_total = 1),
         grouped as (select bucket_index, row_count, aggregates from aggregate_rows where is_total = 0),
         installed_options as (
           select choice_option.value, choice_option.position::integer as position
           from pg_catalog.jsonb_array_elements(%L::jsonb)
             with ordinality as choice_option(value, position)
         ),
         empty_aggregates as (%s),
         columns_result as (
           select coalesce(pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               ''value'', installed.value ->> ''value'',
               ''label'', installed.value ->> ''label'',
               ''rowCount'', case when installed.position = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
               ''aggregates'', case when installed.position = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
             ) order by installed.position
           ), ''[]''::jsonb) as value
           from installed_options as installed
           left join grouped on grouped.bucket_index = installed.position
           cross join empty_aggregates
         ),
         unassigned_result as (
           select pg_catalog.jsonb_build_object(
             ''rowCount'', case when 0 = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
             ''aggregates'', case when 0 = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
           ) as value
           from (select 0::integer as bucket_index) as unassigned
           left join grouped on grouped.bucket_index = unassigned.bucket_index
           cross join empty_aggregates
         )
         select case when candidate_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
           else pg_catalog.jsonb_build_object(
             ''outcome'', ''completed'',
             ''moduleRootId'', %L,
             ''moduleReleaseVersion'', %L,
             ''queryId'', %L,
             ''choiceFieldId'', %L,
             ''totalRowCount'', totals.row_count,
             ''columns'', columns_result.value,
             ''unassigned'', unassigned_result.value,
             ''aggregates'', totals.aggregates
           ) end
         from candidate_count cross join totals
           cross join columns_result cross join unassigned_result',
        candidate_sql,
        selected_sql,
        board_bucket_sql,
        board_requested_positions::text,
        case when aggregate_object_sql = '' then '''{}''::jsonb'
          else pg_catalog.format('pg_catalog.jsonb_build_object(%s)', aggregate_object_sql) end,
        board_options::text,
        board_empty_aggregates_sql,
        board_requested_positions::text, board_requested_positions::text,
        board_requested_positions::text, board_requested_positions::text,
        summary_candidate_limit,
        p_module_root_id::text,
        resolved ->> 'moduleReleaseVersion',
        p_query_id::text,
        board_choice_field_id
      );
    else
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       normalized as materialized (
         select bucket.projected_values, bucket.bucket_index
         from (select candidate.projected_values, %s as bucket_index
           from selected as candidate) as bucket
         where bucket.bucket_index = any (%L::integer[])
       ),
       selected_count as (select pg_catalog.count(*)::integer as value from normalized),
       installed_options as (
         select choice_option.value, choice_option.position::integer as position
         from pg_catalog.jsonb_array_elements(%L::jsonb)
           with ordinality as choice_option(value, position)
       ),
       totals as (%s),
       grouped as (
         select candidate.bucket_index,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from normalized as candidate
         group by candidate.bucket_index
       ),
       empty_aggregates as (%s),
       columns_result as (
         select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             ''value'', installed.value ->> ''value'',
             ''label'', installed.value ->> ''label'',
             ''rowCount'', case when installed.position = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
             ''aggregates'', case when installed.position = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
           ) order by installed.position
         ), ''[]''::jsonb) as value
         from installed_options as installed
         left join grouped on grouped.bucket_index = installed.position
         cross join empty_aggregates
       ),
       unassigned_result as (
         select pg_catalog.jsonb_build_object(
           ''rowCount'', case when 0 = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
           ''aggregates'', case when 0 = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
         ) as value
         from (select 0::integer as bucket_index) as unassigned
         left join grouped on grouped.bucket_index = unassigned.bucket_index
         cross join empty_aggregates
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''choiceFieldId'', %L,
           ''totalRowCount'', selected_count.value,
           ''columns'', columns_result.value,
           ''unassigned'', unassigned_result.value,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals
         cross join columns_result cross join unassigned_result',
      candidate_sql,
      selected_sql,
      board_bucket_sql,
      board_requested_positions::text,
      board_options::text,
      board_totals_sql,
      aggregate_object_sql,
      board_empty_aggregates_sql,
      board_requested_positions::text, board_requested_positions::text,
      board_requested_positions::text, board_requested_positions::text,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      board_choice_field_id
    );
    end if;
  elsif pivot_mode then
    -- One grouping-sets statement yields every cell, each row total, each column total and the
    -- grand total over the full readable filtered set. Averages and extremes are computed for
    -- each set, never combined from cells. Axis values are ordered by (rank, title, canonical
    -- text), so link values follow their readable target title; rows are keyset-paged on that tuple.
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       raw_dimensions as materialized (
         select candidate.projected_values, coalesce(%s, ''null''::jsonb) as row_value, coalesce(%s, ''null''::jsonb) as column_value
         from selected as candidate
         where %s and (select value from candidate_count) <= %s
       ),
       row_values as materialized (
         select * from vortex_record.dimension_value_internal(
           (select pg_catalog.array_agg(distinct row_value) from raw_dimensions), %L::jsonb
         )
       ),
       column_values as materialized (
         select * from vortex_record.dimension_value_internal(
           (select pg_catalog.array_agg(distinct column_value) from raw_dimensions), %L::jsonb
         )
       ),
       dimensions as materialized (
         select source.projected_values, rows.normalized as row_value,
           rows.sort_rank as row_rank, rows.sort_title as row_title,
           columns.normalized as column_value,
           columns.sort_rank as column_rank, columns.sort_title as column_title
         from raw_dimensions as source
         join row_values as rows on rows.value = source.row_value
         join column_values as columns on columns.value = source.column_value
       ),
       crossed as materialized (
         select grouping(candidate.row_value, candidate.column_value) as level,
           candidate.row_rank, candidate.row_title, candidate.row_value,
           candidate.column_rank, candidate.column_title, candidate.column_value,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from dimensions as candidate
         group by grouping sets (
           (candidate.row_rank, candidate.row_title, candidate.row_value,
            candidate.column_rank, candidate.column_title, candidate.column_value),
           (candidate.row_rank, candidate.row_title, candidate.row_value),
           (candidate.column_rank, candidate.column_title, candidate.column_value), ()
         )
       ),
       column_axis as materialized (
         select * from crossed where level = 2
       ),
       column_count as (select pg_catalog.count(*)::integer as value from column_axis),
       row_axis as materialized (
         select crossed.*, pg_catalog.jsonb_build_array(
           crossed.row_rank, crossed.row_title, crossed.row_value::text
         )::text as row_key
         from crossed
         where level = 1
           and (%L::text is null or (
             crossed.row_rank, crossed.row_title collate "C", crossed.row_value::text collate "C"
           ) > (%L::integer, %L::text collate "C", %L::text collate "C"))
         order by crossed.row_rank, crossed.row_title collate "C", crossed.row_value::text collate "C"
         limit %s
       ),
       visible_rows as materialized (
         select * from row_axis
         order by row_rank, row_title collate "C", row_value::text collate "C" limit %s
       ),
       visible_cells as materialized (
         select cell.row_value, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           ''column'', cell.column_value, ''rowCount'', cell.row_count,
           ''aggregates'', cell.aggregates
         ) order by cell.column_rank, cell.column_title collate "C", cell.column_value::text collate "C") as cells
         from crossed as cell
         join visible_rows as visible on visible.row_value = cell.row_value
         where cell.level = 0
         group by cell.row_value
       ),
       grand as (select row_count, aggregates from crossed where level = 3)
       select case
         when candidate_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         when column_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''pivot_columns_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', grand.row_count,
           ''groups'', ''[]''::jsonb,
           ''aggregates'', grand.aggregates,
           ''nextGroupKey'', case when (select pg_catalog.count(*) from row_axis) > %s
             then (select row_key from visible_rows
               order by row_rank desc, row_title collate "C" desc, row_value::text collate "C" desc limit 1)
             else null end,
           ''pivot'', pg_catalog.jsonb_build_object(
             ''rowFieldId'', %L,
             ''columnFieldId'', %L,
             ''rowGroupCount'', (select pg_catalog.count(*) from crossed where level = 1),
             ''columns'', (
               select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 ''value'', axis.column_value, ''rowCount'', axis.row_count, ''aggregates'', axis.aggregates
               ) order by axis.column_rank, axis.column_title collate "C", axis.column_value::text collate "C"), ''[]''::jsonb)
               from column_axis as axis
             ),
             ''rows'', (
               select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 ''key'', visible.row_key, ''value'', visible.row_value, ''rowCount'', visible.row_count,
                 ''aggregates'', visible.aggregates,
                 ''cells'', coalesce(row_cells.cells, ''[]''::jsonb)
               ) order by visible.row_rank, visible.row_title collate "C", visible.row_value::text collate "C"), ''[]''::jsonb)
               from visible_rows as visible
               left join visible_cells as row_cells on row_cells.row_value = visible.row_value
             )
           )
         ) end
       from candidate_count cross join column_count cross join grand',
      candidate_sql,
      selected_sql,
      group_by_terms[1],
      group_by_terms[2],
      group_presence_sql,
      summary_candidate_limit,
      (fields_by_id -> pivot_row_field_id)::text,
      (fields_by_id -> pivot_column_field_id)::text,
      aggregate_object_sql,
      group_after, group_cursor ->> 0, group_cursor ->> 1, group_cursor ->> 2,
      group_page_limit + 1, group_page_limit,
      summary_candidate_limit,
      pivot_column_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text,
      group_page_limit,
      pivot_row_field_id,
      pivot_column_field_id
    );
  elsif pg_catalog.cardinality(group_ids) > 0 then
    -- Groups are ordered and keyset-paged on (rank, title, canonical value); the group key a member
    -- read selects by stays the canonical value text.
    groups_json_sql := pg_catalog.format(
      '(select coalesce(pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           ''groupKey'', grouped.group_values::text,
           ''groupValues'', grouped.group_values,
           ''rowCount'', grouped.row_count,
           ''aggregates'', grouped.aggregates
         ) order by grouped.sort_rank, grouped.sort_title collate "C", grouped.group_values::text collate "C"
       ), ''[]''::jsonb) from visible_groups as grouped)'
    );
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       selected_count as (select pg_catalog.count(*)::integer as value from selected),
       totals as (%s),
       raw_dimensions as materialized (
         select candidate.projected_values, %s as group_values
         from selected as candidate
         where %s and (select value from candidate_count) <= %s
       ),
       %saxis_values as materialized (%s),
       dimensions as materialized (
         select source.projected_values, axis.normalized as group_values, axis.sort_rank, axis.sort_title
         from raw_dimensions as source
         join axis_values as axis on axis.value = source.group_values
       ),
       grouped as (
         select candidate.group_values, candidate.sort_rank, candidate.sort_title,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from dimensions as candidate
         group by candidate.group_values, candidate.sort_rank, candidate.sort_title
       ),
       paged_groups as materialized (
         select * from grouped
         where %L::text is null or (
           grouped.sort_rank, grouped.sort_title collate "C", grouped.group_values::text collate "C"
         ) > (%L::integer, %L::text collate "C", %L::text collate "C")
         order by grouped.sort_rank, grouped.sort_title collate "C", grouped.group_values::text collate "C"
         limit %s
       ),
       visible_groups as materialized (
         select * from paged_groups
         order by sort_rank, sort_title collate "C", group_values::text collate "C" limit %s
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', selected_count.value,
           ''groups'', %s,
           ''aggregates'', totals.aggregate_values,
           ''nextGroupKey'', case when (select pg_catalog.count(*) from paged_groups) > %s
             then (select pg_catalog.jsonb_build_array(sort_rank, sort_title, group_values::text)::text
               from visible_groups
               order by sort_rank desc, sort_title collate "C" desc, group_values::text collate "C" desc limit 1)
             else null end
         ) end
       from candidate_count cross join selected_count cross join totals',
      candidate_sql,
      selected_sql,
      summary_totals_sql,
      group_values_sql,
      group_presence_sql,
      summary_candidate_limit,
      group_axis_ctes_sql,
      group_dimension_sql,
      aggregate_object_sql,
      group_after, group_cursor ->> 0, group_cursor ->> 1, group_cursor ->> 2,
      group_page_limit + 1, group_page_limit,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text,
      groups_json_sql,
      group_page_limit
    );
  else
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       selected_count as (select pg_catalog.count(*)::integer as value from selected),
       totals as (%s)
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', selected_count.value,
           ''groups'', ''[]''::jsonb,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals',
      candidate_sql,
      selected_sql,
      summary_totals_sql,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text
    );
  end if;

  begin
    execute summary_sql into result_value
      using context_organization_id, context_application_root_id, null::text[], null::uuid,
        summary_candidate_limit + 1, access_owner_account_id, access_owner_group_ids,
        access_shared_record_ids, filter_parameters, access_parameters, null::jsonb,
        filter_condition, filter_types, parameter_types, parameter_values,
        filter_ids, summary_field_ids, search_field_ids, user_search;
  exception
    when invalid_parameter_value then
      -- Only the query condition evaluator's refusal is a filter the reader got wrong; any other
      -- invalid parameter is a platform fault and propagates to the adapter, which logs it.
      get stacked diagnostics error_message = message_text;
      if error_message is distinct from 'Query condition is invalid' then
        raise;
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    when sqlstate 'V3187' then
      -- A readable date bucket left the supported year domain (grouping_value_internal).
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'value_out_of_range');
  end;
  -- A grid's grouped read carries the reader's field bound, as its plain page read does, so the
  -- collapsed table offers the same controls without reading a member page.
  if p_user_inputs ? 'grouping' and result_value ->> 'outcome' = 'completed' then
    result_value := result_value || pg_catalog.jsonb_build_object(
      'fieldBounds', pg_catalog.jsonb_build_object(
        'readableFieldIds', pg_catalog.to_jsonb(bound_field_ids),
        'searchable', search_field_ids && bound_field_ids
      )
    );
  end if;
  return result_value;
end
$function$;

alter function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_owner;

revoke all on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) is
  'Owner-only summary execution over the access plan prepared by the protected adapter entry point; explicit organisation and application scope and the exact read plan bound every aggregate scan, including a pivot crossed in one grouping-sets statement and every link grouping dimension folded through one protected title batch per link field; a grid''s grouped read also returns the reader''s guaranteed field bound.';

-- Remove the superseded read relations, including their composite row types.
do $drop_projection_views$
declare
  projection_view record;
begin
  for projection_view in
    select relation.relname
    from vortex_record.storage_catalogue as storage
    join pg_catalog.pg_namespace as namespace on namespace.nspname = 'record_data'
    join pg_catalog.pg_class as relation
      on relation.relnamespace = namespace.oid
      and relation.relname = storage.physical_table_token and relation.relkind = 'v'
    where storage.physical_schema_token = 'system_projection'
  loop
    execute pg_catalog.format('drop view record_data.%I', projection_view.relname);
  end loop;
end
$drop_projection_views$;

reset role;

-- Record adapter functions keep their owner.
set local role vortex_record_adapter;

create or replace function vortex_record.prepare_system_projection_scan_internal(
  p_plan jsonb,
  p_search jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  filter_condition jsonb := nullif(p_plan #> '{filter,residualCondition}', 'null'::jsonb);
  filter_types jsonb := coalesce(p_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types jsonb := coalesce(p_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values jsonb := coalesce(p_plan #> '{filter,residualInputs}', '{}'::jsonb);
  record_type_item jsonb := p_plan -> 'recordType';
  resolved jsonb := p_plan -> 'resolved';
  v_storage_contract_id uuid := (p_plan #>> '{storage,storageContractId}')::uuid;
  query_module_root_id uuid := (p_plan ->> 'queryModuleRootId')::uuid;
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  user_search text := p_search ->> 'search';
  fields_by_id jsonb;
  filter_ids text[];
  readable_field_ids text[];
  search_field_ids text[];
  projection_field_keys jsonb;
  projection_database_types jsonb;
  projection_search_keys text[];
  projection_predicate jsonb;
  scan_source_sql text;
begin
  -- This plan is local to the query invocation, never caller-writable session state.
  select pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value)
  into fields_by_id
  from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'readableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_search -> 'fieldIds') as item(value);
  -- The prepared filter and search are handed to the bounded reader, which
  -- applies them inside its own indexed keyset scan before the limit. A
  -- field the reader is not guaranteed to see on every row may not decide
  -- which rows a page holds, so it is refused rather than filtered per row.
  if filter_condition is not null then
    if exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select coalesce(pg_catalog.jsonb_object_agg(referenced.id, fields_by_id -> referenced.id ->> 'key'),
      '{}'::jsonb)
    into projection_field_keys
    from pg_catalog.unnest(filter_ids) as referenced(id);
    select coalesce(pg_catalog.jsonb_object_agg(mapping.field_id::text, mapping.database_value_type),
      '{}'::jsonb)
    into projection_database_types
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.state = 'active'
      and mapping.field_id::text = any (filter_ids);
    projection_predicate := pg_catalog.jsonb_build_object('filter', pg_catalog.jsonb_build_object(
      'condition', filter_condition,
      'fieldKeys', projection_field_keys,
      'fieldTypes', filter_types,
      'fieldDatabaseTypes', projection_database_types,
      'inputTypes', parameter_types,
      'inputValues', parameter_values));
  end if;
  if user_search is not null then
    if exists (
      select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
      where searched.id <> all (readable_field_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select coalesce(pg_catalog.array_agg(fields_by_id -> searched.id ->> 'key' order by searched.position),
      array[]::text[])
    into projection_search_keys
    from pg_catalog.unnest(search_field_ids) with ordinality as searched(id, position);
    projection_predicate := coalesce(projection_predicate, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'search', pg_catalog.jsonb_build_object(
        'term', user_search, 'keys', pg_catalog.to_jsonb(projection_search_keys)));
  end if;
  -- Explicit definition-derived columns shape the bounded reader values.
  -- No record_data relation is created or read for a system projection.
  scan_source_sql := pg_catalog.format($source$
    pg_catalog.jsonb_to_recordset($11) as projection(
      organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
    )
    cross join lateral pg_catalog.jsonb_to_record(
      pg_catalog.jsonb_build_object(
        'organisation_id', projection.organization_id,
        'module_root_id', %L::uuid,
        'record_type_id', %L::uuid,
        'storage_contract_id', %L::uuid,
        'record_id', projection.record_id,
        'definition_revision', %L::bigint,
        'lifecycle_state', 'active',
        'concurrency_number', projection.revision
      ) || coalesce((
        select pg_catalog.jsonb_object_agg(
          'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
          case
            when field.value ->> 'fieldId' = %L
              then pg_catalog.to_jsonb(projection.organization_id::text)
            when field.value ->> 'fieldId' = %L
              then pg_catalog.to_jsonb(projection.revision)
            else projection.attribute_values -> (field.value ->> 'key')
          end
        )
        from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
      ), '{}'::jsonb)
    ) as stored(%s)$source$,
    query_module_root_id, record_type_id_value,
    v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
    record_type_item #>> '{systemProjection,organizationFieldId}',
    record_type_item #>> '{systemProjection,revisionFieldId}',
    record_type_item, vortex_record.system_projection_columns_internal(record_type_item)
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'predicate', projection_predicate, 'sourceSql', scan_source_sql);
end
$function$;

alter function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb) is
  'Prepares one bounded system-projection scan from the query invocation''s current private plan: refuses filters or searches over fields not guaranteed readable, builds the typed predicate for the registered reader, and maps its rows into explicit definition-derived columns; performs no row read or predicate evaluation.';

create or replace function vortex_record.load_record_access_facts_with_plan_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb,
  p_plan jsonb,
  p_projection_row jsonb,
  p_requested_field_ids jsonb default null
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
  target_is_system_projection boolean;
  preview_target boolean;
  target_source_sql text;
  target_projection_definition jsonb;
  target_projection_sort_key text;
  projection_reader_sql text;
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
  batch_record_ids uuid[];
  loaded_row record;
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
  selected_field_ids jsonb;
  selected_fields jsonb;
  selected_value_expression text;
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

  -- Step 2: the exact installation and its access plan, both supplied by the
  -- trusted caller (this internal is not executable by request roles). The
  -- caller resolves the plan once and passes it as a local value; it is checked
  -- against the verified request context below.
  plan := p_plan;
  if plan is null or pg_catalog.jsonb_typeof(plan) <> 'object' then
    raise exception using errcode = '22023',
      message = 'Record adapter access plan is invalid';
  end if;
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
  if pg_catalog.jsonb_typeof(target_meta -> 'isSystemProjection')
    is distinct from 'boolean' then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  end if;
  target_is_system_projection := (target_meta ->> 'isSystemProjection')::boolean;

  target_source_sql := pg_catalog.format('record_data.%I as stored', target_table);
  if target_is_system_projection then
    select storage.record_type_definition into target_projection_definition
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (target_meta ->> 'storageContractId')::uuid
      and storage.physical_schema_token = 'system_projection'
      and storage.state = 'active';
    if not found then
      raise exception using errcode = '55000',
        message = 'Protected projection reader is unavailable';
    end if;
    if pg_catalog.jsonb_typeof(target_projection_definition -> 'fields') is distinct from 'array'
      or pg_catalog.jsonb_typeof(target_projection_definition -> 'systemProjection')
        is distinct from 'object' then
      raise exception using errcode = '55000',
        message = 'Protected projection definition is invalid';
    end if;
    select field.value ->> 'key' into target_projection_sort_key
    from pg_catalog.jsonb_array_elements(target_projection_definition -> 'fields')
      as field(value)
    where field.value ->> 'fieldId'
      = target_projection_definition #>> '{systemProjection,sortableFieldIds,0}';
    if target_projection_definition #> '{systemProjection,sortableFieldIds,0}' is not null
      and target_projection_sort_key is null then
      raise exception using errcode = '55000',
        message = 'Protected projection sort field is invalid';
    end if;
    target_projection_sort_key := coalesce(target_projection_sort_key, 'record_id');
    -- Shape protected reader values with explicit definition-derived columns.
    projection_reader_sql := case when p_projection_row is null then pg_catalog.format(
      'vortex_record.read_system_projection_rows_internal(%L::uuid, array[$2]::uuid[], %L, ''ascending'', null::jsonb, 1, null::jsonb) as projection',
      (target_meta ->> 'storageContractId')::uuid, target_projection_sort_key
    ) else
      'pg_catalog.jsonb_to_record($3) as projection(organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)'
    end;
    target_source_sql := pg_catalog.format($source$
      %s
      cross join lateral pg_catalog.jsonb_to_record(
        pg_catalog.jsonb_build_object(
          'organisation_id', projection.organization_id,
          'module_root_id', %L::uuid,
          'record_type_id', %L::uuid,
          'storage_contract_id', %L::uuid,
          'record_id', projection.record_id,
          'definition_revision', %L::bigint,
          'lifecycle_state', 'active',
          'concurrency_number', projection.revision
        ) || coalesce((
          select pg_catalog.jsonb_object_agg(
            'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
            case
              when field.value ->> 'fieldId' = %L
                then pg_catalog.to_jsonb(projection.organization_id::text)
              when field.value ->> 'fieldId' = %L
                then pg_catalog.to_jsonb(projection.revision)
              else projection.attribute_values -> (field.value ->> 'key')
            end
          )
          from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
        ), '{}'::jsonb)
      ) as stored(%s)$source$,
      projection_reader_sql, target_module_root_id, p_record_type_id,
      (target_meta ->> 'storageContractId')::uuid, target_release_revision,
      target_projection_definition #>> '{systemProjection,organizationFieldId}',
      target_projection_definition #>> '{systemProjection,revisionFieldId}',
      target_projection_definition,
      vortex_record.system_projection_columns_internal(target_projection_definition)
    );
  end if;

  -- A preview reads its own copy of every record type except a system projection: that is the
  -- platform's live read model, which a preview reads on the live path under the reader's own
  -- live access, never as the preview's owner.
  preview_target := p_installation ? 'previewInstallationId' and not target_is_system_projection;

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
    when required_permissions is null
      and not preview_target then null
    else pg_catalog.jsonb_build_object(
      'operationKey', 'record.' || p_action_kind,
      'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', coalesce(required_permissions, '[]'::jsonb),
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', target_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', case when preview_target
          then 'preview_owner' else 'permission' end
      )
    )
  end;

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  selected_value_expression := target_meta ->> 'valueExpression';
  if p_requested_field_ids is not null then
    if pg_catalog.jsonb_typeof(p_requested_field_ids) is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value)
        where pg_catalog.jsonb_typeof(item.value) <> 'string'
          or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
      ) then
      raise exception using errcode = '22023', message = 'Requested record fields are invalid';
    end if;
    -- Access conditions must see the same operands even when no visible placement consumes them.
    -- Read-time calculations also need their stored dependencies, without disclosing those values.
    select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(item.value)), '[]'::jsonb)
    into selected_field_ids
    from (
      select value from pg_catalog.jsonb_array_elements_text(p_requested_field_ids)
      union all
      select value #>> '{}' from pg_catalog.jsonb_path_query(condition_list, 'lax $.**.declaredFieldIds[*]') as dependency(value)
      union all
      select dependency.value #>> '{}'
      from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as field(value)
      cross join lateral (values
        (field.value #> '{settings,expression,dueFieldId}'),
        (field.value #> '{settings,expression,statusFieldId}')
      ) as dependency(value)
      where p_requested_field_ids ? pg_catalog.lower(field.value ->> 'fieldId')
        and field.value ->> 'type' = 'calculation'
    ) as item(value);
    select coalesce(pg_catalog.jsonb_agg(field.value), '[]'::jsonb) into selected_fields
    from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as field(value)
    where selected_field_ids ? pg_catalog.lower(field.value ->> 'fieldId');
    selected_value_expression := coalesce(vortex_record.named_action_storage_columns_internal(
      (target_meta ->> 'storageContractId')::uuid, selected_fields
    ) ->> 'valueExpression', '');
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
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from %s
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    selected_value_expression, target_source_sql,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id, p_projection_row;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  -- A compatible reprovision can advance the catalogue definition while an
  -- older release remains installed. Report that exact projection definition;
  -- generated records keep their persisted last-written definition revision.
  if target_is_system_projection then
    target_definition_revision := target_release_revision;
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
      select coalesce(pg_catalog.array_agg(distinct queued.record_id), array[]::uuid[])
      into batch_record_ids
      from pg_catalog.unnest(load_contracts, load_records)
        as queued(contract_id, record_id)
      where queued.contract_id = current_contract
        and not records_by_id ? pg_catalog.lower(queued.record_id::text);

      select coalesce(pg_catalog.array_agg(queued.contract_id order by queued.ordinality), array[]::uuid[]),
        coalesce(pg_catalog.array_agg(queued.record_id order by queued.ordinality), array[]::uuid[])
      into load_contracts, load_records
      from pg_catalog.unnest(load_contracts, load_records) with ordinality
        as queued(contract_id, record_id, ordinality)
      where queued.contract_id <> current_contract;

      if pg_catalog.array_length(batch_record_ids, 1) is null then
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
        'select stored.record_id, pg_catalog.jsonb_build_object(
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
           else ''{}''::jsonb end as fact
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = any($2)',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );

      for loaded_row in execute load_sql using context_organization_id, batch_record_ids loop
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(loaded_row.record_id::text), loaded_row.fact
        );
      end loop;
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
    'accessPermissions', permission_by_id,
    'recordTypeMeta', target_meta - 'isSystemProjection',
    'isSystemProjection', target_is_system_projection,
    'table', target_table,
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'fieldValues', target_fact -> 'fieldValues'
  ) || case when preview_target
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', p_installation -> 'previewInstallationId'
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_with_plan_internal(uuid,text,uuid,bigint,jsonb,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_with_plan_internal(
  uuid, text, uuid, bigint, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_with_plan_internal(uuid,text,uuid,bigint,jsonb,jsonb,jsonb,jsonb) to vortex_owner;

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb,
  p_direction text,
  p_exact_record_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- A page ending at this candidate budget still returns its position for the next request.
  scan_limit constant integer := 500;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  exact_ids_refusal text;
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  bound_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_source_sql text;
  search_prefilter_sql text := 'true';
  scan_projection_sql text := 'null::jsonb';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_batch jsonb;
  projection_after jsonb; projection_batch_size integer;
  projection_candidate_count integer := 0; projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  projection_predicate jsonb;
  projection_plan jsonb;
  projection_failure text;
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  page_first_loaded jsonb;
  -- Every row shares the validated installation, facts envelope and read-time inputs.
  page_shared jsonb; page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  first_returned_sort_key text[];
  first_returned_record_id uuid;
  next_value jsonb := null;
  opposite_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_plan jsonb;
  search_field_ids text[] := array[]::text[];
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  -- Every board column this call reads: one for a member page, every displayed
  -- column for a board's first pages, each finished in its own pass below.
  board_columns_mode boolean := false;
  board_columns jsonb := '[]'::jsonb;
  board_column_item jsonb;
  board_column_position integer := 0;
  board_column_pages jsonb := '[]'::jsonb;
  -- The stored choice column, when the reader is guaranteed to see the choice
  -- field on every scanned row, and the current column's candidate predicate.
  board_choice_column text;
  board_scan_sql text := '';
  -- A board's first pages read the table once for every column when the choice field is not
  -- guaranteed readable: each readable row is classified into its column from its own readable
  -- value, and every column keeps its own page state (rows, capability inputs, first and last
  -- returned row, and whether more cards follow) in the arrays below, by column position.
  board_shared_scan boolean := false;
  board_column_index integer;
  shared_rows jsonb[] := array[]::jsonb[];
  shared_capabilities jsonb[] := array[]::jsonb[];
  shared_counts integer[] := array[]::integer[];
  shared_more boolean[] := array[]::boolean[];
  shared_first_keys jsonb[] := array[]::jsonb[];
  shared_first_ids uuid[] := array[]::uuid[];
  shared_last_keys jsonb[] := array[]::jsonb[];
  shared_last_ids uuid[] := array[]::uuid[];
  group_member jsonb;
  group_selector jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_member_matches boolean;
  group_scan_predicate text;
  group_link_field_id text; group_link_cache jsonb := '{}'::jsonb; group_link_values jsonb[];
  group_link_scan_sql text := 'null::jsonb';
  preview_mode boolean := false;
  -- A tree level: the roots of a tree (records with no readable parent) or the
  -- children of one parent, over a one-record link of the record type to itself.
  tree_mode boolean := false;
  tree_field_id text;
  tree_parent_id uuid;
  tree_relationship_id uuid;
  tree_item jsonb;
  tree_filter jsonb;
  tree_filter_predicate text;
  tree_candidates uuid[];
  tree_root_child_ids uuid[] := array[]::uuid[];
  tree_root_nonroot_ids uuid[];
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- An exact read names 1..200 distinct, non-nil record ids and asks for exactly that many rows.
  if p_exact_record_ids is not null then
    -- CASE checks dimensions before array_position, which requires one dimension.
    exact_ids_refusal := case
      when pg_catalog.cardinality(p_exact_record_ids) > 200 then 'exact_ids_too_many'
      when pg_catalog.array_ndims(p_exact_record_ids) is distinct from 1
        or pg_catalog.cardinality(p_exact_record_ids) = 0 then 'exact_ids_invalid'
      when pg_catalog.array_position(p_exact_record_ids, null) is not null
        or '00000000-0000-0000-0000-000000000000'::uuid = any (p_exact_record_ids)
        or (select pg_catalog.count(distinct exact_id.id) from pg_catalog.unnest(p_exact_record_ids) as exact_id(id))
          <> pg_catalog.cardinality(p_exact_record_ids) then 'exact_ids_invalid'
      when p_page_size is distinct from pg_catalog.cardinality(p_exact_record_ids)
        or (p_after is not null and p_after <> 'null'::jsonb) then 'exact_ids_page_invalid'
    end;
    if exact_ids_refusal is not null then
      raise log '%', pg_catalog.jsonb_build_object('part', 'exact_ids', 'reason', exact_ids_refusal);
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
  end if;
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;
  -- User field sets narrow the published contract; they never supply authority.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  board_columns_mode := p_user_inputs ? 'boardColumns';
  group_member_mode := p_user_inputs ? 'groupMember';
  if (board_member_mode and group_member_mode)
    or (board_columns_mode and (board_member_mode or group_member_mode)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- A board's first pages: every requested column, each from its start.
  if board_columns_mode and (p_direction <> 'forward' or p_exact_record_ids is not null
    or (p_after is not null and p_after <> 'null'::jsonb)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := board_member_mode or board_columns_mode;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'boardColumns', 'groupMember', 'grouping', 'tree'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  tree_mode := p_user_inputs ? 'tree';
  if tree_mode and (board_member_mode or group_member_mode or p_user_inputs ? 'grouping'
    or p_exact_record_ids is not null) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := vortex_record.group_member_selector_internal(p_user_inputs -> 'groupMember');
    if group_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := p_user_inputs #> '{groupMember,values}';
    group_selector_types := group_member -> 'types';
    group_selector_values := group_member -> 'values';
  end if;
  if board_member_mode then
    board_member := vortex_record.board_column_selector_internal(
      p_user_inputs -> case when board_columns_mode then 'boardColumns' else 'boardMember' end,
      board_columns_mode
    );
    if board_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := board_member ->> 'choiceFieldId';
    board_columns := board_member -> 'columns';
  end if;
  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);
  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_user_inputs ? 'grouping' and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if board_member_mode and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    -- The search plan is read further down; a board member read carries no search term at all.
    or nullif(pg_catalog.btrim(p_user_inputs ->> 'search'), '') is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if p_exact_record_ids is not null and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;
  if p_user_inputs ? 'grouping' then
    query_item := vortex_record.grouping_query_internal(
      query_item, record_type_item, p_user_inputs -> 'grouping', 50
    );
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;
  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    group_by_ids := vortex_record.query_group_member_fields_internal(
      query_item, fields_by_id, group_selector, group_selector_types);
    if group_by_ids is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_exact_record_ids is null and p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  if pg_catalog.jsonb_typeof(prepared_plan -> 'fieldBoundIds') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no field bound';
  end if;
  select coalesce(pg_catalog.array_agg(item.value order by item.value), array[]::text[])
  into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'fieldBoundIds') as item(value)
  where fields_by_id ? item.value;
  if p_user_inputs ? 'grouping' and not (
    pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}') = any (readable_field_ids)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if tree_mode then
    tree_item := vortex_record.query_tree_selector_internal(
      p_user_inputs -> 'tree', record_type_item, bound_field_ids);
    if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
    tree_field_id := tree_item ->> 'fieldId';
    tree_parent_id := (tree_item ->> 'parentRecordId')::uuid;
    tree_relationship_id := (tree_item ->> 'relationshipId')::uuid;
  end if;
  search_plan := vortex_record.query_search_plan_internal(
    p_user_inputs, fields_by_id, declared_searchable_ids);
  if search_plan ->> 'outcome' <> 'completed' then return search_plan; end if;
  user_search := search_plan ->> 'search';
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(search_plan -> 'fieldIds') as item(value);
  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(board_columns) as requested(value)
      where requested.value ->> 'kind' = 'option'
        and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    -- A column reads only its own cards. When the reader is guaranteed to see the
    -- choice field on every row the scan examines, the stored choice value is the
    -- readable value, so the column's membership narrows the candidate scan and the
    -- budget is spent on that column's members only. Otherwise the scan stays
    -- unnarrowed and membership is decided from each readable projection below, so
    -- a withheld value never decides which rows are examined.
    if board_choice_field_id = any (readable_field_ids) then
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = board_choice_field_id::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if mapping_row.database_value_type = 'text' then
        board_choice_column := mapping_row.physical_column_token;
      end if;
    end if;
  end if;
  -- Sort only on readable fields: validate declared keys, refuse unbounded user keys, and end
  -- with record identity. A withheld published key never changes membership or reveals its value.
  if board_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  elsif group_member_mode then
    -- Grouping keys are constant within this exact selector. Remove them from
    -- the query's default member order; record identity still breaks every tie.
    select coalesce(pg_catalog.jsonb_agg(item.value order by item.position), '[]'::jsonb)
    into effective_sort
    from pg_catalog.jsonb_array_elements(query_item -> 'sort') with ordinality as item(value, position)
    where pg_catalog.lower(item.value ->> 'fieldId') <> all (group_by_ids);
    effective_sort_is_user := false;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 0 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;
  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  -- Push membership through the stored field; recheck the projected bucket below.
  if p_user_inputs ? 'grouping' then
    group_key := pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}');
    select mapping.* into mapping_row from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id and mapping.field_id = group_key::uuid;
    if not found or mapping_row.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    begin
      group_scan_predicate := vortex_record.grouping_member_predicate_internal(
        mapping_row.physical_column_token, mapping_row.database_value_type,
        fields_by_id -> group_key ->> 'type', p_user_inputs -> 'grouping', group_selector_values -> group_key
      );
    exception when sqlstate 'V3187' then
      -- The forged or stale selector's date bucket is outside the supported year domain.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'value_out_of_range');
    end;
    if group_scan_predicate is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    filter_predicate := '(' || filter_predicate || ') and (' || group_scan_predicate || ')';
    if group_selector_values -> group_key = '"not_available"'::jsonb then
      group_link_scan_sql := pg_catalog.format('stored.%I', mapping_row.physical_column_token);
    end if;
    if fields_by_id -> group_key ->> 'type' = 'link' then
      group_link_field_id := group_key;
      group_link_cache := vortex_record.group_link_unreadable_internal(
        group_link_cache, array[group_selector_values -> group_key], fields_by_id -> group_key);
      if coalesce((group_link_cache ->> (group_selector_values -> group_key ->> 'recordId'))::boolean, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
    end if;
  end if;
  tree_filter_predicate := filter_predicate;
  if tree_mode and tree_parent_id is not null then
    filter_predicate := '(' || filter_predicate || ') and ' || pg_catalog.format(
      'exists (select 1 from vortex_record.relationship_edges as tree_edge'
      || ' where tree_edge.relationship_id = %1$L::uuid and tree_edge.from_organisation_id = stored.organisation_id'
      || ' and tree_edge.from_storage_contract_id = %2$L::uuid and tree_edge.from_record_id = stored.record_id'
      || ' and tree_edge.to_record_id = $16)',
      tree_relationship_id, v_storage_contract_id);
  end if;
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);
  if tree_mode then
    -- Every tree relative read applies the query's own filter and the viewer's search, exactly as
    -- the level scan does: the pushed predicate, the filtered fields' readability and the residual.
    tree_filter := pg_catalog.jsonb_build_object(
      'predicate', tree_filter_predicate, 'parameters', filter_parameters, 'exact', filter_exact,
      'condition', filter_condition, 'fieldTypes', filter_types,
      'inputTypes', parameter_types, 'inputs', parameter_values,
      'fieldIds', pg_catalog.to_jsonb(filter_ids),
      'valuesSql', (select pg_catalog.string_agg(
          filter_chunk.pairs_text,
          ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index)
        from (
          select (filter_pair.pair_number - 1) / 50 as chunk_index,
            pg_catalog.string_agg(
              filter_pair.pair_text, ', ' order by filter_pair.pair_number
            ) as pairs_text
          from pg_catalog.unnest(filter_expressions)
            with ordinality as filter_pair(pair_text, pair_number)
          group by (filter_pair.pair_number - 1) / 50
        ) as filter_chunk),
      'searchFieldIds', pg_catalog.to_jsonb(search_field_ids), 'search', user_search);
  end if;
  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;
  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when p_direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when p_direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;
  scan_source_sql := pg_catalog.format('record_data.%I as stored', physical_table_token);
  projection_page_scan := not preview_mode and record_type_item ? 'systemProjection'
    and not board_member_mode and not group_member_mode and not tree_mode
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and vortex_record.has_bounded_system_projection_reader_internal(
      v_storage_contract_id, fields_by_id -> sort_ids[1] ->> 'key'
    );
  if record_type_item ? 'systemProjection' and not projection_page_scan then
    -- Protected rows have exactly one bounded scan path. Unsupported shapes
    -- must never fall through to generated record_data storage.
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode',
      case when board_member_mode or group_member_mode or tree_mode
        then 'descriptor_invalid' else 'sort_invalid' end);
  end if;
  if projection_page_scan then
      projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
      if projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is unavailable';
      end if;
      projection_after := p_after;
      projection_batch_size := least(p_page_size, scan_limit);
      projection_plan := vortex_record.prepare_system_projection_scan_internal(
        prepared_plan || pg_catalog.jsonb_build_object('queryModuleRootId', p_module_root_id), search_plan);
      if projection_plan ->> 'outcome' <> 'prepared' then return projection_plan; end if;
      projection_predicate := projection_plan -> 'predicate';
      scan_source_sql := projection_plan ->> 'sourceSql';
      -- The one place the predicate is applied is the reader's scan.
      filter_predicate := 'true';
      filter_exact := true;
      filter_expressions := array[]::text[];
      begin
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
        into projection_batch
        from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
          null::uuid[], projection_sort_key, scan_directions[1], projection_after,
          projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
          record_id, revision, attribute_values, ordinality);
      exception when sqlstate '22023' then
        get stacked diagnostics projection_failure = message_text;
        if projection_failure in ('filter_field_not_declared', 'predicate_unsupported') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', projection_failure);
        end if;
        raise;
      end;
      scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;
  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);
    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;
  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;
  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  else
    -- A search narrows the candidate scan, and so the budget, through the one shared
    -- stored-value pre-predicate; the per-row search match below stays the decision.
    search_prefilter_sql := vortex_record.query_search_prefilter_internal(
      v_storage_contract_id, fields_by_id, search_field_ids, readable_field_ids, user_search, 17, 18);
  end if;
  -- One pass per requested board column, each with its own page, budget and
  -- position; every other read makes exactly one pass. The page's access facts,
  -- eligibility and validated record types stay those of this one invocation.
  <<column_pass>>
  loop
  if board_member_mode then
    board_column_position := board_column_position + 1;
    exit column_pass when board_column_position > pg_catalog.jsonb_array_length(board_columns);
    board_column_item := board_columns -> (board_column_position - 1);
    board_column_kind := board_column_item ->> 'kind';
    board_column_value := board_column_item ->> 'value';
    if board_column_position = 1 and board_columns_mode and board_choice_column is null then
      board_shared_scan := true;
      shared_rows := pg_catalog.array_fill('[]'::jsonb, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_capabilities := shared_rows;
      shared_counts := pg_catalog.array_fill(0, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_more := pg_catalog.array_fill(false, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_first_keys := pg_catalog.array_fill('null'::jsonb, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_first_ids := pg_catalog.array_fill(null::uuid, array[pg_catalog.jsonb_array_length(board_columns)]);
      shared_last_keys := shared_first_keys;
      shared_last_ids := shared_first_ids;
    end if;
    board_scan_sql := case
      when board_choice_column is null then ''
      when board_column_kind = 'option' then pg_catalog.format(
        ' and stored.%I collate "C" = $13 collate "C"', board_choice_column)
      else pg_catalog.format(
        ' and (stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
        board_choice_column)
    end;
    if board_column_position > 1 and not board_shared_scan then
      examined := 0;
      budget_exhausted := false;
      more_rows := false;
      rows_value := '[]'::jsonb;
      row_count := 0;
      capability_rows := array[]::jsonb[];
      decided_ids := array[]::uuid[];
      decided_loaded := null;
      decided_decisions := null;
      decided_bounds := null;
      last_examined_sort_key := null;
      last_examined_record_id := null;
      last_returned_sort_key := null;
      last_returned_record_id := null;
      first_returned_sort_key := null;
      first_returned_record_id := null;
      next_value := null;
      opposite_value := null;
    end if;
  end if;
  if not (board_shared_scan and board_column_position > 1) then
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row,
       %s as group_link_value
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12::uuid[] is null or stored.record_id = any ($12))
       and %s
       and (%s)
        and (case when (%s) then true else false end)%s%s
        and (%s)
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    scan_projection_sql,
    group_link_scan_sql,
    scan_source_sql,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    board_scan_sql,
    segment_sql,
    search_prefilter_sql,
    order_by_sql
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters, projection_batch, p_exact_record_ids,
      board_column_value, board_option_values, group_selector_values, tree_parent_id, search_field_ids, user_search;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;
    if passes then
      page_access_loaded := null;
      if not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        -- The installation and its access plan are resolved once for the page;
        -- every exact record decision below consumes this local plan.
        page_shared := pg_catalog.jsonb_build_object(
          'installation', case when preview_mode
            then vortex_record.read_current_preview_installation_internal()
            else vortex_definition.read_current_active_installation() end);
        page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
          vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
        page_access_loaded := vortex_record.load_record_access_facts_with_plan_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', page_shared -> 'plan', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          if preview_mode then
            -- Owner authority and the exact storage binding were validated by
            -- preparation and the first loader in this invocation. Bounds are
            -- identical for every copied row of this record type.
            page_shared := page_shared || pg_catalog.jsonb_build_object(
              'previewBounds', vortex_record.preview_record_field_bounds_internal(
                record_type_id_value, v_storage_contract_id, record_type_item));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= p_page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if tree_mode and tree_parent_id is null then
          -- Root membership uses exact batched parent decisions, never the access superset.
          if not (scan_record.record_id = any (tree_root_child_ids)) then
            tree_root_child_ids := array[scan_record.record_id];
            while pg_catalog.cardinality(tree_root_child_ids) <= p_page_size loop
              fetch scan_cursor into lookahead_record;
              exit when not found;
              tree_root_child_ids := pg_catalog.array_append(tree_root_child_ids, lookahead_record.record_id);
            end loop;
            move absolute cursor_position from scan_cursor;
            tree_item := vortex_record.read_query_tree_relatives_internal(
              true, tree_root_child_ids, tree_relationship_id, context_organization_id,
              context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
              tree_filter);
            if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_nonroot_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'recordIds') as item(value);
          end if;
          if scan_record.record_id = any (tree_root_nonroot_ids) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A root's unreadable parent must not be disclosed as a link value.
          readable_values := pg_catalog.jsonb_set(readable_values, array[tree_field_id], 'null'::jsonb);
        end if;
        -- Filters decide membership, so every referenced value must be readable.
        -- Sorts only decide order: the scan already drops unguaranteed sort keys
        -- and ends with record identity. A withheld published sort field must
        -- neither remove a readable row nor expose its value through ordering.
        if not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) and not exists (
          select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
          where projection_page_scan and user_search is not null
            and not (readable_values ? searched.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_shared_scan then
            -- The one scan serves every column: this row belongs to the column its readable
            -- choice value names, or to the unassigned column when it names no option. A row of a
            -- column that already holds its page and the card after it is not read again.
            board_column_index := (
              select requested.ordinality::integer
              from pg_catalog.jsonb_array_elements(board_columns) with ordinality
                as requested(value, ordinality)
              where case when (readable_values ? board_choice_field_id)
                  and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                  and (readable_values ->> board_choice_field_id) collate "C"
                    = any (board_option_values)
                then requested.value ->> 'kind' = 'option'
                  and (requested.value ->> 'value') collate "C"
                    = (readable_values ->> board_choice_field_id) collate "C"
                else requested.value ->> 'kind' = 'unassigned' end
              limit 1
            );
            if board_column_index is null or shared_more[board_column_index] then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
            rows_value := shared_rows[board_column_index];
            capability_rows := array(select item.value from pg_catalog.jsonb_array_elements(
              shared_capabilities[board_column_index]) as item(value));
            row_count := shared_counts[board_column_index];
            first_returned_record_id := shared_first_ids[board_column_index];
            first_returned_sort_key := case
              when pg_catalog.jsonb_typeof(shared_first_keys[board_column_index]) = 'array'
              then array(select item.value from pg_catalog.jsonb_array_elements_text(
                shared_first_keys[board_column_index]) as item(value)) end;
          elsif board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches and group_link_field_id is not null
              and group_selector_values -> group_link_field_id = '"not_available"'::jsonb then
              -- The group of unreadable targets: one protected title batch decides the targets of this
              -- row and the page's next candidates together; the cache holds each target once per call.
              if pg_catalog.jsonb_typeof(readable_values -> group_link_field_id) = 'object'
                and not (group_link_cache ? (readable_values -> group_link_field_id ->> 'recordId')) then
                group_link_values := array[readable_values -> group_link_field_id];
                while pg_catalog.cardinality(group_link_values) <= p_page_size loop
                  fetch scan_cursor into lookahead_record;
                  exit when not found;
                  group_link_values := pg_catalog.array_append(group_link_values, lookahead_record.group_link_value);
                end loop;
                move absolute cursor_position from scan_cursor;
                group_link_cache := vortex_record.group_link_unreadable_internal(
                  group_link_cache, group_link_values, fields_by_id -> group_link_field_id);
              end if;
              group_member_matches := coalesce(
                (group_link_cache ->> (readable_values -> group_link_field_id ->> 'recordId'))::boolean, false);
            elsif group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, vortex_record.grouping_value_internal(
                readable_values -> grouped.id, fields_by_id -> grouped.id ->> 'type', p_user_inputs #> '{grouping,dateBucket}'
              ))
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if tree_mode and tree_parent_id is not null and not (
            pg_catalog.jsonb_typeof(readable_values -> tree_field_id) = 'object'
            and pg_catalog.lower(readable_values -> tree_field_id ->> 'recordId') = pg_catalog.lower(tree_parent_id::text)
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if user_search is not null and not projection_page_scan
            and not vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, user_search
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if row_count = p_page_size then
            -- A shared scan's column with its page and a matching card after it has more cards;
            -- the scan ends only when every column has.
            if board_shared_scan then
              shared_more[board_column_index] := true;
              if pg_catalog.array_position(shared_more, false) is null then
                more_rows := true;
                exit;
              end if;
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
            more_rows := true;
            exit;
          end if;
          if row_count = 0 then
            first_returned_sort_key := scan_record.sort_key;
            first_returned_record_id := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          row_count := row_count + 1;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
          if board_shared_scan then
            shared_rows[board_column_index] := rows_value;
            shared_capabilities[board_column_index] := pg_catalog.to_jsonb(capability_rows);
            shared_counts[board_column_index] := row_count;
            shared_first_keys[board_column_index] := pg_catalog.to_jsonb(first_returned_sort_key);
            shared_first_ids[board_column_index] := first_returned_record_id;
            shared_last_keys[board_column_index] := pg_catalog.to_jsonb(last_returned_sort_key);
            shared_last_ids[board_column_index] := last_returned_record_id;
          end if;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or more_rows or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(p_page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, scan_directions[1], projection_after,
    projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
    record_id, revision, attribute_values, ordinality);
  end loop;
  exit when more_rows or budget_exhausted;
  end loop;
  end if;
  -- The shared scan has read every column: this column's page state is the one its rows left,
  -- and its continuations are its own, never an earlier column's.
  if board_shared_scan then
    next_value := null;
    opposite_value := null;
    rows_value := shared_rows[board_column_position];
    capability_rows := array(select item.value from pg_catalog.jsonb_array_elements(
      shared_capabilities[board_column_position]) as item(value));
    row_count := shared_counts[board_column_position];
    more_rows := shared_more[board_column_position];
    first_returned_record_id := shared_first_ids[board_column_position];
    first_returned_sort_key := case
      when pg_catalog.jsonb_typeof(shared_first_keys[board_column_position]) = 'array'
      then array(select item.value from pg_catalog.jsonb_array_elements_text(
        shared_first_keys[board_column_position]) as item(value)) end;
    last_returned_record_id := shared_last_ids[board_column_position];
    last_returned_sort_key := case
      when pg_catalog.jsonb_typeof(shared_last_keys[board_column_position]) = 'array'
      then array(select item.value from pg_catalog.jsonb_array_elements_text(
        shared_last_keys[board_column_position]) as item(value)) end;
  end if;
  if projection_batch_exhausted and not more_rows then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows), page_shared -> 'envelope'
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
      raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
    end if;
    -- Each row gets its own capabilities, in one pass over the page.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if tree_mode and row_count > 0 then
    select pg_catalog.array_agg((item.value ->> 'recordId')::uuid) into tree_candidates
    from pg_catalog.jsonb_array_elements(rows_value) as item(value);
    tree_item := vortex_record.read_query_tree_relatives_internal(
      false, tree_candidates, tree_relationship_id, context_organization_id,
      context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
      page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
      tree_filter);
    if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
    -- A parent the examination budget did not decide has no answer yet: null, never a refusal.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'hasChildren', case when (tree_item -> 'undecidedIds') ? (item.value ->> 'recordId') then null
          else (tree_item -> 'recordIds') ? (item.value ->> 'recordId') end) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;
  if first_returned_record_id is not null then
    opposite_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(first_returned_sort_key),
      'phase', case when pg_catalog.cardinality(first_returned_sort_key) > 0
        and first_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', first_returned_record_id
    );
  end if;
  if p_direction = 'backward' and row_count > 1 then
    select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  exit column_pass when not board_columns_mode;
  board_column_pages := board_column_pages || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('column', board_column_item, 'rows', rows_value, 'next', next_value)
  );
  end loop column_pass;
  if preview_mode then
    -- No rows leave this invocation until the builder's authority is current
    -- again. Its role/group path can expire while the page is assembled;
    -- invocation-local reuse must never extend that permission deadline.
    if vortex_record.read_current_preview_installation_internal() -> 'previewInstallationId'
      is distinct from prepared_plan #> '{preview,previewInstallationId}' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if board_columns_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'columns', board_column_pages,
      'fieldBounds', pg_catalog.jsonb_build_object(
        'readableFieldIds', pg_catalog.to_jsonb(bound_field_ids),
        'searchable', search_field_ids && bound_field_ids
      )
    );
  end if;
  -- The reader's current field bound travels with the page, even an empty one: the fields it is
  -- guaranteed to see on every record it may read, and whether a search can match through any.
  -- A generic group member page also names its exact group.
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value,
    'opposite', opposite_value,
    'fieldBounds', pg_catalog.jsonb_build_object(
      'readableFieldIds', pg_catalog.to_jsonb(bound_field_ids),
      'searchable', search_field_ids && bound_field_ids
    )
  ) || case when group_member_mode then pg_catalog.jsonb_build_object(
    'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
    'groupValues', group_selector_values
  ) else '{}'::jsonb end;
end
$function$;
alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text,uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[])
  to vortex_request;
comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[]) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; returns with every plain page and board column read, even an empty one, the reader''s current field bound (the fields it is guaranteed to see on every record it may read, and whether any searchable field is among them) so a list offers and accepts its filter, search and sort controls from the same read; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, reads one column''s member page or, for a board''s first pages, the first page of every requested column in one invocation with its own budget and position per column, classifies those columns from current readable values and, when the choice field is guaranteed readable on every scanned row, narrows each column''s candidate scan to its own stored choice value so a column reads only its own cards, and otherwise reads the table once for every column, each readable row going to the column its readable value names, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values, and a grid dimension narrows the stored candidate scan only after the field is proven guaranteed readable, with date bucket membership using the same authored-zone canonical value as the summary and typed half-open calendar ranges; reads one level of a tree over a one-record link of the record type to itself, either the roots (records whose parent no readable record matching the query''s filter and search holds, so an unreadable parent is never revealed and a matching record under a non-matching parent stays reachable) or the children of one parent, through the same keyset order, access scan, filter, search and exact per-row decision as a plain page, requiring the parent link to be a field the reader is guaranteed to see and reporting for every returned record, from one bounded set of rounds over the whole page rather than one query per row, whether the reader may read a child of it that matches the query, or that this is undecided when the rounds'' examination budget ran out; orders board pages by record identity and generic members by the requested or query order with bidirectional keysets, returns generic group identity and the reader''s field bound even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; reads the copied records of a preview like installed ones and refuses a system projection in a preview; with a list of 1 to 200 distinct record ids it reads exactly those records in one page, each under the same scope, release, filter, search and readability decision as any row, and returns only those readable now.';

reset role;
