create or replace function vortex_record.read_import_update_targets(
  p_record_type_id uuid,
  p_mapped_field_ids jsonb,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  uuid_pattern constant text := '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
  context_initial jsonb;
  context_final jsonb;
  installation_initial jsonb;
  installation_final jsonb;
  meta_initial jsonb;
  meta_final jsonb;
  record_type_value jsonb;
  mapped_ids uuid[] := array[]::uuid[];
  mapped_ids_value jsonb := '[]'::jsonb;
  target_results jsonb := '[]'::jsonb;
  target_item record;
  target_value jsonb;
  row_number_value bigint;
  row_number_values bigint[] := array[]::bigint[];
  record_id_candidate text;
  target_record_id uuid;
  initial_read jsonb;
  initial_capabilities jsonb;
  final_read jsonb;
  final_capabilities jsonb;
  row_values jsonb;
  field_id_value uuid;
  field_type_value text;
  field_matches integer;
  binding_matches integer;
  key_count integer;
  action_value text;
  action_values text[];
  capability_field_value text;
  capability_field_id uuid;
  capability_field_ids uuid[];
  projection_field_value text;
  projection_field_id uuid;
  projection_field_ids uuid[];
  mapped_field_id uuid;
  mapped_fields_available boolean;
  row_result jsonb;
  result_value jsonb;
  issued_at_value timestamptz;
  valid_until_value timestamptz;
  now_value timestamptz;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_mapped_field_ids) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mapped_field_ids) < 1
    or pg_catalog.jsonb_array_length(p_mapped_field_ids) > 500
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) < 1
    or pg_catalog.jsonb_array_length(p_targets) > 50 then
    raise exception using errcode = '22023', message = 'Import update target request is invalid';
  end if;

  for target_item in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(p_mapped_field_ids) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if pg_catalog.jsonb_typeof(target_item.value) is distinct from 'string'
      or (target_item.value #>> '{}') !~* uuid_pattern then
      raise exception using errcode = '22023', message = 'Import update target mapping is invalid';
    end if;
    begin
      field_id_value := (target_item.value #>> '{}')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'Import update target mapping is invalid';
    end;
    if field_id_value = nil_uuid or field_id_value = any(mapped_ids) then
      raise exception using errcode = '22023', message = 'Import update target mapping is invalid';
    end if;
    mapped_ids := pg_catalog.array_append(mapped_ids, field_id_value);
    mapped_ids_value := mapped_ids_value || pg_catalog.jsonb_build_array(
      pg_catalog.to_jsonb(field_id_value::text)
    );
  end loop;

  context_initial := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(context_initial) is distinct from 'object'
    or context_initial ->> 'callerKind' is distinct from 'human'
    or not (context_initial ? 'applicationRootId')
    or context_initial ->> 'identityId' is null
    or context_initial ->> 'organizationAccountId' is null
    or context_initial ->> 'issuedAt' is null
    or context_initial ->> 'expiresAt' is null then
    raise exception using errcode = '42501', message = 'Import update targets require a human Application request';
  end if;

  issued_at_value := (context_initial ->> 'issuedAt')::timestamptz;
  valid_until_value := least(
    (context_initial ->> 'expiresAt')::timestamptz,
    issued_at_value + interval '30 seconds'
  );
  now_value := pg_catalog.clock_timestamp();
  if not pg_catalog.isfinite(issued_at_value)
    or not pg_catalog.isfinite(valid_until_value)
    or now_value >= valid_until_value then
    raise exception using errcode = '22023', message = 'Import update target request has expired';
  end if;

  installation_initial := vortex_module.read_current_active_installation();
  if pg_catalog.jsonb_typeof(installation_initial) is distinct from 'object'
    or (installation_initial ->> 'organizationId')::uuid
      is distinct from (context_initial ->> 'organizationId')::uuid
    or (installation_initial ->> 'applicationRootId')::uuid
      is distinct from (context_initial ->> 'applicationRootId')::uuid
    or pg_catalog.jsonb_typeof(installation_initial -> 'moduleBindings') is distinct from 'array' then
    raise exception using errcode = '55000', message = 'Active installation evidence is invalid';
  end if;

  meta_initial := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  if pg_catalog.jsonb_typeof(meta_initial) is distinct from 'object'
    or meta_initial ? 'previewInstallationId'
    or pg_catalog.jsonb_typeof(meta_initial -> 'recordType') is distinct from 'object'
    or pg_catalog.jsonb_typeof(meta_initial -> 'context') is distinct from 'object'
    or meta_initial -> 'context' is distinct from context_initial
    or pg_catalog.jsonb_typeof(meta_initial -> 'recordType' -> 'fields') is distinct from 'array'
    or meta_initial -> 'recordType' ? 'systemProjection' then
    raise exception using errcode = '55000', message = 'Installed Record metadata is unavailable';
  end if;

  record_type_value := meta_initial -> 'recordType';
  if (record_type_value ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or (record_type_value ->> 'storageContractId')::uuid
      is distinct from (meta_initial ->> 'storageContractId')::uuid
    or record_type_value ->> 'storageScope' is distinct from meta_initial ->> 'storageScope'
    or pg_catalog.jsonb_array_length(record_type_value -> 'fields') > 500
    or pg_catalog.octet_length(pg_catalog.convert_to(record_type_value::text, 'UTF8')) > 262144 then
    raise exception using errcode = '55000', message = 'Installed Record definition is invalid';
  end if;

  select pg_catalog.count(*) into binding_matches
  from pg_catalog.jsonb_array_elements(installation_initial -> 'moduleBindings') as binding(value)
  where (binding.value ->> 'organizationId')::uuid = (context_initial ->> 'organizationId')::uuid
    and (binding.value ->> 'applicationRootId')::uuid = (context_initial ->> 'applicationRootId')::uuid
    and (binding.value ->> 'applicationReleaseRevision')::bigint =
      (installation_initial ->> 'applicationReleaseRevision')::bigint
    and binding.value ->> 'state' = 'active'
    and (binding.value ->> 'moduleRootId')::uuid = (meta_initial ->> 'moduleRootId')::uuid
    and (binding.value ->> 'moduleReleaseRevision')::bigint =
      (meta_initial ->> 'moduleReleaseRevision')::bigint;
  if binding_matches <> 1 then
    raise exception using errcode = '55000', message = 'Installed Record Module binding is unavailable';
  end if;

  for target_item in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(p_mapped_field_ids) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    field_id_value := (target_item.value #>> '{}')::uuid;
    select pg_catalog.count(*), pg_catalog.min(field.value ->> 'type')
    into field_matches, field_type_value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
    where (field.value ->> 'fieldId')::uuid = field_id_value;
    if field_matches <> 1
      or field_type_value in ('reference_number', 'calculation', 'total') then
      raise exception using errcode = '22023', message = 'Import update target mapping is unsupported';
    end if;
  end loop;

  -- Validate the complete target batch before any target UUID cast or Record lookup.
  for target_item in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(p_targets) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    target_value := target_item.value;
    if pg_catalog.jsonb_typeof(target_value) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Import update target row is invalid';
    end if;
    select pg_catalog.count(*) into key_count
    from pg_catalog.jsonb_object_keys(target_value) as supplied(key);
    if key_count <> 2
      or not (target_value ?& array['rowNumber', 'recordIdCandidate'])
      or pg_catalog.jsonb_typeof(target_value -> 'rowNumber') is distinct from 'number'
      or (target_value ->> 'rowNumber') !~ '^[1-9][0-9]*$'
      or (target_value ->> 'rowNumber')::numeric > 9007199254740991
      or pg_catalog.jsonb_typeof(target_value -> 'recordIdCandidate') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Import update target row is invalid';
    end if;
    row_number_value := (target_value ->> 'rowNumber')::bigint;
    if row_number_value = any(row_number_values) then
      raise exception using errcode = '22023', message = 'Import update target rows are duplicated';
    end if;
    row_number_values := pg_catalog.array_append(row_number_values, row_number_value);
    record_id_candidate := target_value ->> 'recordIdCandidate';
    if pg_catalog.octet_length(pg_catalog.convert_to(record_id_candidate, 'UTF8')) > 256 then
      raise exception using errcode = '22023', message = 'Import update target identifier is too large';
    end if;
  end loop;
  row_number_values := array[]::bigint[];

  for target_item in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(p_targets) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    target_value := target_item.value;
    if pg_catalog.jsonb_typeof(target_value) is distinct from 'object'
      or not (target_value ?& array['rowNumber', 'recordIdCandidate']) then
      raise exception using errcode = '22023', message = 'Import update target row is invalid';
    end if;
    select pg_catalog.count(*) into key_count
    from pg_catalog.jsonb_object_keys(target_value) as supplied(key);
    if key_count <> 2
      or pg_catalog.jsonb_typeof(target_value -> 'rowNumber') is distinct from 'number'
      or (target_value ->> 'rowNumber') !~ '^[1-9][0-9]*$'
      or (target_value ->> 'rowNumber')::numeric > 9007199254740991
      or pg_catalog.jsonb_typeof(target_value -> 'recordIdCandidate') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Import update target row is invalid';
    end if;
    row_number_value := (target_value ->> 'rowNumber')::bigint;
    if row_number_value = any(row_number_values) then
      raise exception using errcode = '22023', message = 'Import update target rows are duplicated';
    end if;
    row_number_values := pg_catalog.array_append(row_number_values, row_number_value);
    record_id_candidate := target_value ->> 'recordIdCandidate';
    if pg_catalog.octet_length(pg_catalog.convert_to(record_id_candidate, 'UTF8')) > 256 then
      raise exception using errcode = '22023', message = 'Import update target identifier is too large';
    end if;

    if record_id_candidate !~* uuid_pattern then
      row_result := pg_catalog.jsonb_build_object(
        'rowNumber', row_number_value, 'status', 'refused', 'code', 'invalid_record_id'
      );
      target_results := target_results || pg_catalog.jsonb_build_array(row_result);
      continue;
    end if;
    begin
      target_record_id := record_id_candidate::uuid;
    exception when others then
      row_result := pg_catalog.jsonb_build_object(
        'rowNumber', row_number_value, 'status', 'refused', 'code', 'invalid_record_id'
      );
      target_results := target_results || pg_catalog.jsonb_build_array(row_result);
      continue;
    end;
    if target_record_id = nil_uuid then
      row_result := pg_catalog.jsonb_build_object(
        'rowNumber', row_number_value, 'status', 'refused', 'code', 'invalid_record_id'
      );
      target_results := target_results || pg_catalog.jsonb_build_array(row_result);
      continue;
    end if;

    initial_read := vortex_record.read_record(p_record_type_id, target_record_id);
    initial_capabilities := vortex_record.read_record_capabilities(p_record_type_id, target_record_id);
    if pg_catalog.jsonb_typeof(initial_read) is distinct from 'object' then
      raise exception using errcode = '55000', message = 'Record reader returned malformed facts';
    end if;
    -- A neutral row must not conceal malformed facts from either reader.
    if initial_capabilities is not null then
      if pg_catalog.jsonb_typeof(initial_capabilities) is distinct from 'object'
        or not (initial_capabilities ?& array['actions', 'changeableFieldIds'])
        or pg_catalog.jsonb_typeof(initial_capabilities -> 'actions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(initial_capabilities -> 'changeableFieldIds') is distinct from 'array' then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
      end if;
      select pg_catalog.count(*) into key_count
      from pg_catalog.jsonb_object_keys(initial_capabilities) as supplied(key);
      if key_count <> 2 then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
      end if;
    end if;
    select pg_catalog.count(*) into key_count
    from pg_catalog.jsonb_object_keys(initial_read) as supplied(key);
    if initial_read ->> 'outcome' = 'refused' then
      if key_count <> 1 then
        raise exception using errcode = '55000', message = 'Record reader returned malformed facts';
      end if;
    else
      if initial_read ->> 'outcome' is distinct from 'allowed'
        or pg_catalog.jsonb_typeof(initial_read -> 'values') is distinct from 'object' then
        raise exception using errcode = '55000', message = 'Record reader returned malformed facts';
      end if;
      if key_count <> 4 or not (initial_read ?& array['outcome', 'recordId', 'concurrencyNumber', 'values']) then
        raise exception using errcode = '55000', message = 'Record reader returned malformed facts';
      end if;
      if (initial_read ->> 'recordId') !~* uuid_pattern
        or (initial_read ->> 'recordId')::uuid is distinct from target_record_id
        or pg_catalog.jsonb_typeof(initial_read -> 'concurrencyNumber') is distinct from 'number'
        or (initial_read ->> 'concurrencyNumber') !~ '^[1-9][0-9]*$'
        or (initial_read ->> 'concurrencyNumber')::numeric > 9007199254740991
        or pg_catalog.octet_length(pg_catalog.convert_to((initial_read -> 'values')::text, 'UTF8')) > 65536 then
        raise exception using errcode = '55000', message = 'Record reader returned malformed facts';
      end if;

      projection_field_ids := array[]::uuid[];
      for projection_field_value in
        select key from pg_catalog.jsonb_object_keys(initial_read -> 'values') as projected(key)
      loop
        if projection_field_value !~* uuid_pattern then
          raise exception using errcode = '55000', message = 'Record projection returned malformed fields';
        end if;
        begin
          projection_field_id := projection_field_value::uuid;
        exception when others then
          raise exception using errcode = '55000', message = 'Record projection returned malformed fields';
        end;
        if projection_field_id = nil_uuid
          or projection_field_id = any(projection_field_ids)
          or not exists (
          select 1
          from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
          where (field.value ->> 'fieldId')::uuid = projection_field_id
        ) then
          raise exception using errcode = '55000', message = 'Record projection returned malformed fields';
        end if;
        projection_field_ids := pg_catalog.array_append(projection_field_ids, projection_field_id);
      end loop;
    end if;

    if initial_capabilities is not null then
      action_values := array[]::text[];
      for target_item in
        select item.value from pg_catalog.jsonb_array_elements(initial_capabilities -> 'actions') as item(value)
      loop
        if pg_catalog.jsonb_typeof(target_item.value) is distinct from 'string' then
          raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
        end if;
        action_value := target_item.value #>> '{}';
        if action_value not in ('update', 'delete', 'restore') or action_value = any(action_values) then
          raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
        end if;
        action_values := pg_catalog.array_append(action_values, action_value);
      end loop;

      capability_field_ids := array[]::uuid[];
      for capability_field_value in
        select item.value #>> '{}'
        from pg_catalog.jsonb_array_elements(initial_capabilities -> 'changeableFieldIds') as item(value)
      loop
        if capability_field_value !~* uuid_pattern then
          raise exception using errcode = '55000', message = 'Record capability reader returned malformed fields';
        end if;
        begin
          capability_field_id := capability_field_value::uuid;
        exception when others then
          raise exception using errcode = '55000', message = 'Record capability reader returned malformed fields';
        end;
        if capability_field_id = nil_uuid
          or capability_field_id = any(capability_field_ids)
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
            where (field.value ->> 'fieldId')::uuid = capability_field_id
          ) then
          raise exception using errcode = '55000', message = 'Record capability reader returned malformed fields';
        end if;
        capability_field_ids := pg_catalog.array_append(capability_field_ids, capability_field_id);
      end loop;
    end if;

    if initial_read ->> 'outcome' = 'refused' or initial_capabilities is null then
      row_result := pg_catalog.jsonb_build_object(
        'rowNumber', row_number_value, 'status', 'refused', 'code', 'target_unavailable'
      );
      target_results := target_results || pg_catalog.jsonb_build_array(row_result);
      continue;
    end if;

    mapped_fields_available := 'update' = any(action_values);
    if mapped_fields_available then
      foreach mapped_field_id in array mapped_ids loop
        if not exists (
          select 1
          from pg_catalog.jsonb_object_keys(initial_read -> 'values') as projected(key)
          where pg_catalog.lower(projected.key) = mapped_field_id::text
        ) or not (mapped_field_id = any(capability_field_ids)) then
          mapped_fields_available := false;
          exit;
        end if;
      end loop;
    end if;
    if not mapped_fields_available then
      row_result := pg_catalog.jsonb_build_object(
        'rowNumber', row_number_value, 'status', 'refused', 'code', 'target_unavailable'
      );
      target_results := target_results || pg_catalog.jsonb_build_array(row_result);
      continue;
    end if;

    final_read := vortex_record.read_record(p_record_type_id, target_record_id);
    final_capabilities := vortex_record.read_record_capabilities(p_record_type_id, target_record_id);
    if pg_catalog.jsonb_typeof(final_read) is distinct from 'object'
      or final_read ->> 'outcome' is distinct from 'allowed'
      or pg_catalog.jsonb_typeof(final_read -> 'values') is distinct from 'object'
      or final_capabilities is null
      or pg_catalog.jsonb_typeof(final_capabilities) is distinct from 'object'
      or not (final_capabilities ?& array['actions', 'changeableFieldIds'])
      or pg_catalog.jsonb_typeof(final_capabilities -> 'actions') is distinct from 'array'
      or pg_catalog.jsonb_typeof(final_capabilities -> 'changeableFieldIds') is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record facts changed during import preview';
    end if;
    if (final_read ->> 'recordId') !~* uuid_pattern
      or (final_read ->> 'recordId')::uuid is distinct from target_record_id
      or final_read -> 'concurrencyNumber' is distinct from initial_read -> 'concurrencyNumber'
      or final_read -> 'values' is distinct from initial_read -> 'values' then
      raise exception using errcode = '55000', message = 'Record facts changed during import preview';
    end if;
    select pg_catalog.count(*) into key_count
    from pg_catalog.jsonb_object_keys(final_read) as supplied(key);
    if key_count <> 4
      or not (final_read ?& array['outcome', 'recordId', 'concurrencyNumber', 'values'])
      or pg_catalog.jsonb_typeof(final_read -> 'concurrencyNumber') is distinct from 'number'
      or (final_read ->> 'concurrencyNumber') !~ '^[1-9][0-9]*$'
      or (final_read ->> 'concurrencyNumber')::numeric > 9007199254740991
      or pg_catalog.octet_length(pg_catalog.convert_to((final_read -> 'values')::text, 'UTF8')) > 65536 then
      raise exception using errcode = '55000', message = 'Record reader returned malformed facts';
    end if;
    select pg_catalog.count(*) into key_count
    from pg_catalog.jsonb_object_keys(final_capabilities) as supplied(key);
    if key_count <> 2 then
      raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
    end if;

    -- The update action and every mapped field must remain available.
    -- Changes to unrelated delete or restore actions are not update evidence.
    action_values := array[]::text[];
    for target_item in
      select item.value from pg_catalog.jsonb_array_elements(final_capabilities -> 'actions') as item(value)
    loop
      if pg_catalog.jsonb_typeof(target_item.value) is distinct from 'string' then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
      end if;
      action_value := target_item.value #>> '{}';
      if action_value not in ('update', 'delete', 'restore') or action_value = any(action_values) then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed facts';
      end if;
      action_values := pg_catalog.array_append(action_values, action_value);
    end loop;
    capability_field_ids := array[]::uuid[];
    for capability_field_value in
      select item.value #>> '{}'
      from pg_catalog.jsonb_array_elements(final_capabilities -> 'changeableFieldIds') as item(value)
    loop
      if capability_field_value !~* uuid_pattern then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed fields';
      end if;
      begin
        capability_field_id := capability_field_value::uuid;
      exception when others then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed fields';
      end;
      if capability_field_id = nil_uuid
        or capability_field_id = any(capability_field_ids)
        or not exists (
          select 1
          from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
          where (field.value ->> 'fieldId')::uuid = capability_field_id
        ) then
        raise exception using errcode = '55000', message = 'Record capability reader returned malformed fields';
      end if;
      capability_field_ids := pg_catalog.array_append(capability_field_ids, capability_field_id);
    end loop;
    if not ('update' = any(action_values)) then
      raise exception using errcode = '55000', message = 'Record update capability changed during import preview';
    end if;
    foreach mapped_field_id in array mapped_ids loop
      if not (mapped_field_id = any(capability_field_ids)) then
        raise exception using errcode = '55000', message = 'Record update capability changed during import preview';
      end if;
    end loop;

    row_values := initial_read -> 'values';
    row_result := pg_catalog.jsonb_build_object(
      'rowNumber', row_number_value,
      'status', 'matched',
      'recordId', target_record_id,
      'expectedConcurrencyNumber', (initial_read ->> 'concurrencyNumber')::numeric,
      'existingValues', row_values,
      'changeableFieldIds', mapped_ids_value,
      'access', pg_catalog.jsonb_build_object(
        'state', 'allowed', 'operation', 'update', 'targetRecordId', target_record_id
      ),
      'match', pg_catalog.jsonb_build_object(
        'method', 'record_id', 'state', 'matched', 'recordId', target_record_id,
        'existingValues', row_values
      )
    );
    target_results := target_results || pg_catalog.jsonb_build_array(row_result);
  end loop;

  context_final := vortex_access.validated_human_request_context();
  installation_final := vortex_module.read_current_active_installation();
  meta_final := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  if context_final is distinct from context_initial
    or installation_final is distinct from installation_initial
    or meta_final is distinct from meta_initial then
    raise exception using errcode = '55000', message = 'Import update target context changed';
  end if;
  now_value := pg_catalog.clock_timestamp();
  if now_value >= valid_until_value then
    raise exception using errcode = '22023', message = 'Import update target request expired during resolution';
  end if;

  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'kind', 'partial_update_target_facts',
    'validationComplete', false,
    'organizationId', (context_initial ->> 'organizationId')::uuid,
    'applicationRootId', (context_initial ->> 'applicationRootId')::uuid,
    'identityId', (context_initial ->> 'identityId')::uuid,
    'organizationAccountId', (context_initial ->> 'organizationAccountId')::uuid,
    'accessVersion', (context_initial ->> 'accessVersion')::numeric,
    'correlationId', (context_initial ->> 'correlationId')::uuid,
    'issuedAt', context_initial -> 'issuedAt',
    'validUntil', pg_catalog.to_jsonb(valid_until_value),
    'activeInstallation', installation_initial,
    'moduleRootId', (meta_initial ->> 'moduleRootId')::uuid,
    'moduleReleaseRevision', (meta_initial ->> 'moduleReleaseRevision')::numeric,
    'storageContractId', (meta_initial ->> 'storageContractId')::uuid,
    'storageScope', meta_initial -> 'storageScope',
    'recordType', record_type_value,
    'mappedFieldIds', mapped_ids_value,
    'rows', target_results
  );
  if pg_catalog.octet_length(pg_catalog.convert_to(result_value::text, 'UTF8')) > 5242880 then
    raise exception using errcode = '54000', message = 'Import update target result is too large';
  end if;
  if pg_catalog.clock_timestamp() >= valid_until_value then
    raise exception using errcode = '22023', message = 'Import update target request expired before return';
  end if;
  return result_value;
end
$function$;

alter function vortex_record.read_import_update_targets(uuid,jsonb,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_import_update_targets(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_import_update_targets(uuid,jsonb,jsonb)
  to vortex_request;

comment on function vortex_record.read_import_update_targets(uuid,jsonb,jsonb) is
  'Returns bounded partial update-target facts for a verified human Application request by composing the current installed Record definition and paired protected Record readers; never writes business records or authorizes execution.';
