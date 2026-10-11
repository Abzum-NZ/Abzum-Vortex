create or replace function vortex_record.authorize_created_records_for_command_internal(
  p_creations jsonb,
  p_created_records jsonb,
  p_original_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  safe_integer_max constant bigint := 9007199254740991;
  current_context jsonb;
  meta jsonb;
  meta_context jsonb;
  loaded jsonb;
  loaded_context jsonb;
  facts jsonb;
  record_fact jsonb;
  record_scope jsonb;
  decision jsonb;
  bounds jsonb;
  creation jsonb;
  created_value jsonb;
  saved_tuple jsonb;
  submitted_field text;
  returned_field text;
  submitted_id uuid;
  changeable_id text;
  ordinal_key text;
  ordinal_value integer;
  record_type_id_value uuid;
  record_id_value uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  module_root_id_value uuid;
  storage_contract_id_value uuid;
  module_release_revision_value bigint;
  definition_revision_value bigint;
  storage_scope_value text;
  actual_concurrency_number bigint;
  expected_record_scope jsonb;
  ordinals integer[] := array[]::integer[];
  seen_map_ordinals integer[] := array[]::integer[];
  seen_record_ids uuid[] := array[]::uuid[];
  result_tuples jsonb := '[]'::jsonb;
  matching_target_count integer;
  eligible_value boolean;
begin
  if pg_catalog.jsonb_typeof(p_creations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_created_records) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_original_context) is distinct from 'object'
    or not (p_original_context ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ])
    or p_original_context - array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_creations) = 0
    or (select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(p_created_records)) <>
      pg_catalog.jsonb_array_length(p_creations) then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_typeof(p_original_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'correlationId', 'uuid'), true) then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;
  organization_id_value := (p_original_context ->> 'organizationId')::uuid;
  application_root_id_value := (p_original_context ->> 'applicationRootId')::uuid;
  account_id_value := (p_original_context ->> 'organizationAccountId')::uuid;
  correlation_id_value := (p_original_context ->> 'correlationId')::uuid;
  if organization_id_value = nil_uuid or application_root_id_value = nil_uuid
    or account_id_value = nil_uuid or correlation_id_value = nil_uuid then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;

  current_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(current_context) is distinct from 'object'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'correlationId', 'uuid'), true)
    or (current_context ->> 'organizationId')::uuid is distinct from organization_id_value
    or (current_context ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (current_context ->> 'organizationAccountId')::uuid is distinct from account_id_value
    or (current_context ->> 'correlationId')::uuid is distinct from correlation_id_value then
    raise exception using errcode = '42501',
      message = 'Named action creation context changed';
  end if;

  -- Validate and retain each canonical ordinal before using it as an object key.
  for creation in
    select item.value from pg_catalog.jsonb_array_elements(p_creations) item(value)
  loop
    if pg_catalog.jsonb_typeof(creation) is distinct from 'object'
      or not (creation ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
      or creation - array['ordinal', 'recordTypeId', 'values', 'finalValues']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(creation -> 'ordinal') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'ordinal', 'integer'), true)
      or pg_catalog.jsonb_typeof(creation -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(creation -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(creation -> 'finalValues') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation authority input is invalid';
    end if;
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    if ordinal_value < 1 or record_type_id_value = nil_uuid
      or ordinal_value = any (ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation ordinal is invalid';
    end if;
    ordinals := pg_catalog.array_append(ordinals, ordinal_value);
  end loop;

  -- A JSON object can contain text keys such as "01" and "1" that cast to the
  -- same integer. Admit only the exact decimal form of each declared ordinal.
  for ordinal_key in
    select item.key from pg_catalog.jsonb_object_keys(p_created_records) item(key)
  loop
    if coalesce(not pg_catalog.pg_input_is_valid(ordinal_key, 'integer'), true) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    ordinal_value := ordinal_key::integer;
    if ordinal_value < 1 or ordinal_key is distinct from ordinal_value::text
      or not (ordinal_value = any (ordinals))
      or ordinal_value = any (seen_map_ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    seen_map_ordinals := pg_catalog.array_append(seen_map_ordinals, ordinal_value);
  end loop;
  if pg_catalog.cardinality(seen_map_ordinals) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '22023',
      message = 'Named action creation result set is incomplete';
  end if;

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
    order by (item.value ->> 'ordinal')::integer
  loop
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    created_value := p_created_records -> ordinal_value::text;
    if pg_catalog.jsonb_typeof(created_value) is distinct from 'object'
      or not (created_value ?& array['recordId', 'storageContractId', 'values', '_savedTuple'])
      or created_value - array['recordId', 'storageContractId', 'values', '_savedTuple']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(created_value -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(created_value -> '_savedTuple') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation result is invalid';
    end if;
    record_id_value := (created_value ->> 'recordId')::uuid;
    storage_contract_id_value := (created_value ->> 'storageContractId')::uuid;
    saved_tuple := created_value -> '_savedTuple';
    if record_id_value = nil_uuid or storage_contract_id_value = nil_uuid
      or pg_catalog.jsonb_typeof(saved_tuple) is distinct from 'object'
      or not (saved_tuple ?& array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ])
      or saved_tuple - array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'organizationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'organizationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') not in ('string', 'null')
      or (pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') = 'string'
        and coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'applicationRootId', 'uuid'), true))
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleRootId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleRootId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(saved_tuple -> 'actorId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'actorId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'eligible') is distinct from 'boolean' then
      raise exception using errcode = '22023',
        message = 'Named action creation tuple is invalid';
    end if;

    if (saved_tuple ->> 'recordId')::uuid is distinct from record_id_value
      or (saved_tuple ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (saved_tuple ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (saved_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
      or (saved_tuple ->> 'actorId')::uuid is distinct from account_id_value
      or (saved_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (saved_tuple ->> 'concurrencyNumber')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleRootId')::uuid = nil_uuid
      or (saved_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
      or ((saved_tuple ->> 'storageScope') = 'application_contained'
        and (saved_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
      or ((saved_tuple ->> 'storageScope') = 'organization_shared'
        and saved_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
      or (saved_tuple ->> 'eligible')::boolean is distinct from
        ((saved_tuple ->> 'storageScope') = 'application_contained') then
      raise exception using errcode = '42501',
        message = 'Named action creation tuple context changed';
    end if;
    if record_id_value = any (seen_record_ids) then
      raise exception using errcode = '22023',
        message = 'Named action creation identity is duplicated';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, record_id_value);

    meta := vortex_record.resolve_record_action_context_internal(record_type_id_value, 'create');
    if pg_catalog.jsonb_typeof(meta) is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'context') is distinct from 'object'
      or meta ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'storageContractId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'correlationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'correlationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'recordType' ->> 'recordTypeId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'storageContractId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleReleaseRevision', 'bigint'), true)
      or meta ->> 'storageScope' is distinct from saved_tuple ->> 'storageScope'
      or (meta ->> 'moduleRootId')::uuid is distinct from (saved_tuple ->> 'moduleRootId')::uuid
      or (meta ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (meta ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint
      or (meta -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (meta -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (meta -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (meta -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (meta -> 'recordType' ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (meta -> 'recordType' ->> 'storageScope') is distinct from saved_tuple ->> 'storageScope'
      or (meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId')::uuid is distinct from
        (saved_tuple ->> 'moduleRootId')::uuid
      or (meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId')::uuid is distinct from
        record_type_id_value
      or (meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId')::uuid is distinct from
        storage_contract_id_value
      or meta -> 'declaration' -> 'recordBinding' ->> 'storageScope' is distinct from
        saved_tuple ->> 'storageScope' then
      raise exception using errcode = '42501',
        message = 'Named action creation installation is unavailable';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_each(creation -> 'finalValues') expected(key, value)
      where not (created_value -> 'values' ? expected.key)
        or (created_value -> 'values' -> expected.key) is distinct from expected.value
    ) then
      raise exception using errcode = '55000',
        message = 'Named action creation values changed';
    end if;
    for returned_field in
      select key from pg_catalog.jsonb_object_keys(created_value -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(returned_field, 'uuid'), true)
        or not (meta -> 'columns' ? pg_catalog.lower(returned_field)) then
        raise exception using errcode = '55000',
          message = 'Named action creation values are unavailable';
      end if;
      if not (creation -> 'finalValues' ? returned_field)
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') field(value)
          where pg_catalog.lower(field.value ->> 'fieldId') =
              pg_catalog.lower(returned_field)
            and field.value ->> 'type' = 'reference_number'
        ) then
        raise exception using errcode = '55000',
          message = 'Named action creation generated value is unavailable';
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      record_type_id_value, 'create', record_id_value, null
    );
    if pg_catalog.jsonb_typeof(loaded) is distinct from 'object'
      or loaded ->> 'outcome' is distinct from 'loaded'
      or loaded ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(loaded -> 'context') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'records') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'recordTypes') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'relationships') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'sharingConditions') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'edges') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'binding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'definitionRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'definitionRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'moduleReleaseRevision', 'bigint'), true)
      or (loaded -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (loaded -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (loaded -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (loaded -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or loaded -> 'facts' -> 'binding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded -> 'declaration' -> 'recordBinding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded ->> 'table' is distinct from meta ->> 'table'
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (meta ->> 'moduleReleaseRevision')::bigint
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation facts are unavailable';
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'relationships') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'sharingConditions') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'edges') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation graph facts are malformed';
    end if;
    actual_concurrency_number := (loaded ->> 'concurrencyNumber')::bigint;
    definition_revision_value := (loaded ->> 'definitionRevision')::bigint;
    if actual_concurrency_number not between 1 and safe_integer_max then
      raise exception using errcode = '55000',
        message = 'Named action creation revision is unavailable';
    end if;
    if definition_revision_value not between 1 and safe_integer_max
      or definition_revision_value is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation definition changed';
    end if;

    matching_target_count := 0;
    record_fact := null;
    for record_fact in
      select item.value from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    loop
      if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'recordScope') is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object' then
        raise exception using errcode = '55000',
          message = 'Named action creation target facts are malformed';
      end if;
      if pg_catalog.jsonb_typeof(record_fact -> 'recordScope' -> 'recordId') = 'string'
        and coalesce(pg_catalog.pg_input_is_valid(
          record_fact -> 'recordScope' ->> 'recordId', 'uuid'
        ), false)
        and (record_fact -> 'recordScope' ->> 'recordId')::uuid = record_id_value then
        matching_target_count := matching_target_count + 1;
      end if;
    end loop;
    if matching_target_count <> 1 then
      raise exception using errcode = '42501',
        message = 'Named action creation target is unavailable';
    end if;

    -- Re-read the one exact saved target from the returned fact set and compare
    -- its complete loader-produced scope; related graph facts never substitute.
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    where item.value -> 'recordScope' ->> 'recordId' = record_id_value::text;
    record_scope := record_fact -> 'recordScope';
    expected_record_scope := pg_catalog.jsonb_build_object(
      'storageScope', saved_tuple ->> 'storageScope',
      'organizationId', organization_id_value,
      'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
      'recordTypeId', record_type_id_value,
      'storageContractId', storage_contract_id_value,
      'recordId', record_id_value
    ) || case when saved_tuple ->> 'storageScope' = 'application_contained'
      then pg_catalog.jsonb_build_object('applicationRootId', application_root_id_value)
      else '{}'::jsonb end;
    if record_scope is distinct from expected_record_scope
      or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object'
      or record_fact ->> 'lifecycleState' is distinct from 'active' then
      raise exception using errcode = '42501',
        message = 'Named action creation target scope changed';
    end if;

    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if pg_catalog.jsonb_typeof(decision) is distinct from 'object'
      or decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501',
        message = 'Named action creation authority is unavailable';
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    if pg_catalog.jsonb_typeof(bounds) is distinct from 'object'
      or pg_catalog.jsonb_typeof(bounds -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(bounds -> 'changeableFieldIds') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
      )
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
          or not (bounds -> 'readableFieldIds' ? (item.value #>> '{}'))
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation field bounds are unavailable';
    end if;
    for submitted_field in
      select key from pg_catalog.jsonb_object_keys(creation -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(submitted_field, 'uuid'), true) then
        raise exception using errcode = '22023',
          message = 'Named action creation field is invalid';
      end if;
      submitted_id := submitted_field::uuid;
      changeable_id := pg_catalog.lower(submitted_id::text);
      if not (meta -> 'columns' ? changeable_id)
        or not exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') item(value)
          where pg_catalog.lower(item.value) = changeable_id
        ) then
        raise exception using errcode = '42501',
          message = 'Named action creation field is not changeable';
      end if;
    end loop;

    eligible_value := (saved_tuple ->> 'eligible')::boolean;
    result_tuples := result_tuples || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', ordinal_value,
        'recordId', record_id_value,
        'concurrencyNumber', actual_concurrency_number,
        'organizationId', organization_id_value,
        'applicationRootId', saved_tuple -> 'applicationRootId',
        'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
        'recordTypeId', record_type_id_value,
        'storageContractId', storage_contract_id_value,
        'moduleReleaseRevision', (loaded ->> 'moduleReleaseRevision')::bigint,
        'storageScope', saved_tuple ->> 'storageScope',
        'correlationId', correlation_id_value,
        'eligible', eligible_value
      )
    );
  end loop;

  if pg_catalog.jsonb_array_length(result_tuples) <> pg_catalog.cardinality(ordinals)
    or pg_catalog.cardinality(seen_record_ids) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '55000',
      message = 'Named action creation authority result is incomplete';
  end if;
  return result_tuples;
end
$function$;

alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) is
  'Private named-action whole-graph ordinary CREATE authorization barrier over the complete inserted set; revalidates the original HUMAN context, installed scope, actual loader target and revision, current Access decision and submitted field bounds, returning ordered final saved tuples for the terminal receipt and created-notice seam.';
