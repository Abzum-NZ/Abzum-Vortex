create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  field_kind text;
  semantic_type text;
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_context.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception when others then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') or resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  if preview_mode and (
    record_type_item ? 'systemProjection'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      where item.value ->> 'type' in ('calculation', 'total')
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb,
          'sharedRecordIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A failure yields no readable fields, so nothing is pushed.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', coalesce(access_plan.access_predicate, 'true'),
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[])),
          'sharedRecordIds', pg_catalog.to_jsonb(coalesce(access_plan.shared_record_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      field_kind := fields_by_id -> field_key ->> 'type';
      if field_kind in ('calculation', 'total') then
        field_kind := fields_by_id -> field_key #>> '{settings,resultType}';
      end if;
      -- The exact (current Module contract) semantics of the saved-condition
      -- evaluator, so Query and database-backed conditions agree.
      semantic_type := case
        when field_kind = 'decimal_number' then 'decimal_number'
        when field_kind = 'money' then 'money'
        when field_kind = 'whole_number' then 'number'
        when field_kind = 'yes_no' then 'boolean'
        when field_kind = 'date' then 'date'
        when field_kind = 'date_time' then 'date_time'
        when field_kind = 'several_choices' then 'text_collection'
        when field_kind in ('table', 'attachment', 'formatted_text') then 'opaque_json'
        when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
        when field_kind = 'link_to_person' then 'organization_account_reference'
        when field_kind in (
          'text', 'long_text', 'choice', 'reference_number',
          'email_address', 'phone_number', 'web_address'
        ) then 'text'
        else null end;
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- The same canonical value text the record reader projects; references
      -- are compared by their identifier, as the condition engine defines.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when semantic_type = 'record_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''recordId''))',
              mapping_row.physical_column_token)
          when semantic_type = 'organization_account_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''organizationAccountId''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs: exactly the declared keys, required ones present, references
  -- reduced to their identifier. Types are checked by the condition bridge.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and (input_item ->> 'required')::boolean then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'recordId'));
    elsif input_value <> 'null'::jsonb and input_item ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['organizationAccountId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'organizationAccountId') ~ uuid_pattern, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'organizationAccountId'));
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        9,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';
