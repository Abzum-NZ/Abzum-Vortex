-- #2090: capture actual created-row tuples, reauthorize the whole graph at both barriers, and publish exact terminal created notices.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.insert_named_action_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  returned_record_id uuid;
  returned_concurrency_number bigint;
  returned_definition_revision bigint;
  returned_organization_id uuid;
  returned_module_root_id uuid;
  returned_record_type_id uuid;
  returned_storage_contract_id uuid;
  returned_application_root_id uuid;
  returned_created_by uuid;
  ownership_mode text;
  owner_account_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := p_final_values;
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  app_scope uuid;
  inserted_rows integer;
  organization_id_value uuid;
  module_root_id_value uuid;
  storage_contract_id_value uuid;
  module_release_revision_value bigint;
  storage_scope_value text;
  actor_id_value uuid;
  eligible_for_created_notice boolean;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <> (
      select pg_catalog.count(distinct value)
      from pg_catalog.unnest(p_submitted_field_ids) as item(value)
    ) then
    raise exception using errcode = '22023', message = 'Named action creation is invalid';
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
  if pg_catalog.jsonb_typeof(meta) is distinct from 'object'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
    or pg_catalog.jsonb_typeof(meta -> 'context') is distinct from 'object'
    or meta ? 'previewInstallationId'
    or pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'recordTypeId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'recordType' ->> 'recordTypeId', 'uuid'), true)
    or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(meta -> 'columns') is distinct from 'object'
    or pg_catalog.jsonb_typeof(meta -> 'table') is distinct from 'string'
    or pg_catalog.jsonb_typeof(meta -> 'storageScope') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'storageContractId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleReleaseRevision', 'bigint'), true) then
    raise exception using errcode = '55000',
      message = 'Named action creation target is unavailable';
  end if;
  context_value := meta -> 'context';
  if pg_catalog.jsonb_typeof(context_value -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(context_value -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(context_value -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(context_value -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(context_value ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(context_value ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(context_value ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(context_value ->> 'correlationId', 'uuid'), true) then
    raise exception using errcode = '55000',
      message = 'Named action creation context is unavailable';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  module_root_id_value := (meta ->> 'moduleRootId')::uuid;
  storage_contract_id_value := (meta ->> 'storageContractId')::uuid;
  module_release_revision_value := (meta ->> 'moduleReleaseRevision')::bigint;
  storage_scope_value := meta ->> 'storageScope';
  if organization_id_value = nil_uuid or (context_value ->> 'applicationRootId')::uuid = nil_uuid
    or actor_id_value = nil_uuid
    or module_root_id_value = nil_uuid or storage_contract_id_value = nil_uuid
    or module_release_revision_value not between 1 and 9007199254740991
    or record_id_value is null or record_id_value = nil_uuid
    or storage_scope_value not in ('application_contained', 'organization_shared') then
    raise exception using errcode = '55000',
      message = 'Named action creation target is unavailable';
  end if;
  app_scope := case when storage_scope_value = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  if storage_scope_value = 'application_contained' and app_scope = nil_uuid then
    raise exception using errcode = '55000',
      message = 'Named action creation context is unavailable';
  end if;
  record_type_value := meta -> 'recordType';
  if (record_type_value ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or record_type_value ->> 'storageScope' is distinct from storage_scope_value then
    raise exception using errcode = '55000',
      message = 'Named action creation target is unavailable';
  end if;
  ownership_mode := record_type_value ->> 'ownershipMode';

  if ownership_mode = 'organization_account' then
    owner_account_id := actor_id_value;
  elsif ownership_mode = 'group' then
    raise exception using errcode = '42501',
      message = 'Named action creation owner is unavailable';
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
    where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
  ) then
    raise exception using errcode = '23514', message = 'Named action creation field is unknown';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id_value := (field_item ->> 'fieldId')::uuid;
    column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
    if pg_catalog.jsonb_typeof(column_value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(column_value -> 'token') is distinct from 'string'
      or pg_catalog.jsonb_typeof(column_value -> 'databaseValueType') is distinct from 'string' then
      raise exception using errcode = '55000',
        message = 'Named action creation storage is unavailable';
    end if;
    if field_item ->> 'type' = 'reference_number' then
      if final_values ? pg_catalog.lower(field_id_value::text)
        or field_id_value = any (p_submitted_field_ids) then
        raise exception using errcode = '23514',
          message = 'Named action creation cannot submit a generated field';
      end if;
      input_value := pg_catalog.to_jsonb(vortex_record.allocate_reference_number_internal(
        organization_id_value, storage_contract_id_value, field_id_value, app_scope,
        field_item -> 'settings'
      ));
      final_values := final_values || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_id_value::text), input_value
      );
    elsif final_values ? pg_catalog.lower(field_id_value::text) then
      input_value := final_values -> pg_catalog.lower(field_id_value::text);
      if (field_item ->> 'required')::boolean
        and pg_catalog.jsonb_typeof(input_value) = 'null' then
        raise exception using errcode = '23514',
          message = 'Named action creation is missing a required value';
      end if;
      if not vortex_record.canonical_record_value_matches(
        input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
      ) then
        raise exception using errcode = '23514',
          message = 'Named action creation value is invalid';
      end if;
    else
      if (field_item ->> 'required')::boolean then
        raise exception using errcode = '23514',
          message = 'Named action creation is missing a required value';
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
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, null, ''active'', 1,
       pg_catalog.statement_timestamp(), $9, pg_catalog.statement_timestamp(), $9%s)
     returning record_id, concurrency_number, definition_revision, organisation_id, module_root_id,
       record_type_id, storage_contract_id, application_root_id, created_by',
    meta ->> 'table',
    case when pg_catalog.cardinality(column_names) = 0 then ''
      else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
    case when pg_catalog.cardinality(column_values) = 0 then ''
      else ', ' || pg_catalog.array_to_string(column_values, ', ') end
  );
  execute insert_sql into returned_record_id, returned_concurrency_number,
    returned_definition_revision,
    returned_organization_id, returned_module_root_id, returned_record_type_id,
    returned_storage_contract_id, returned_application_root_id, returned_created_by
  using organization_id_value, module_root_id_value, p_record_type_id,
    storage_contract_id_value, record_id_value, app_scope,
    module_release_revision_value, owner_account_id, actor_id_value;
  get diagnostics inserted_rows = row_count;
  if inserted_rows <> 1 or returned_record_id is null
    or returned_record_id = nil_uuid or returned_record_id is distinct from record_id_value
    or returned_concurrency_number is null
    or returned_concurrency_number not between 1 and 9007199254740991
    or returned_definition_revision is distinct from module_release_revision_value
    or returned_organization_id is distinct from organization_id_value
    or returned_module_root_id is distinct from module_root_id_value
    or returned_record_type_id is distinct from p_record_type_id
    or returned_storage_contract_id is distinct from storage_contract_id_value
    or returned_application_root_id is distinct from app_scope
    or returned_created_by is distinct from actor_id_value then
    raise exception using errcode = '55000',
      message = 'Named action creation insert result is unavailable';
  end if;

  eligible_for_created_notice := storage_scope_value = 'application_contained';
  if not eligible_for_created_notice then
    perform vortex_record.bump_record_data_version_internal(
      organization_id_value, storage_contract_id_value, app_scope
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'recordId', returned_record_id,
    'storageContractId', returned_storage_contract_id,
    'values', final_values,
    '_savedTuple', pg_catalog.jsonb_build_object(
      'recordId', returned_record_id,
      'concurrencyNumber', returned_concurrency_number,
      'organizationId', returned_organization_id,
      'applicationRootId', returned_application_root_id,
      'moduleRootId', returned_module_root_id,
      'recordTypeId', returned_record_type_id,
      'storageContractId', returned_storage_contract_id,
      'moduleReleaseRevision', module_release_revision_value,
      'storageScope', storage_scope_value,
      'actorId', returned_created_by,
      'correlationId', (context_value ->> 'correlationId')::uuid,
      'eligible', eligible_for_created_notice
    )
  );
end
$function$;

alter function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])
  to vortex_record_adapter;

comment on function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]) is
  'Private named-action insert phase: validates current installed create metadata, allocates required reference values before all edges, captures the actual inserted row and revision with RETURNING, and returns a private tuple for whole-graph authorization and terminal created-notice emission.';

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

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  event_loaded jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  public_created_records jsonb := '{}'::jsonb;
  created_record_tuples jsonb := '[]'::jsonb;
  first_created_record_tuples jsonb := '[]'::jsonb;
  inserted_value jsonb;
  final_created_tuple jsonb;
  saved_tuple jsonb;
  seen_created_ordinals integer[] := array[]::integer[];
  seen_created_ids uuid[] := array[]::uuid[];
  created_ordinal integer;
  created_concurrency_number bigint;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  copy_plan jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_rows integer;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- A lifecycle command is the terminal delete, restore or ownership transfer.
  -- Delete and restore reach here only after their protected preflight has
  -- already run and claimed the record_lifecycle receipt; this operation owns
  -- the one terminal write and completes it. The request role reaches these
  -- branches only through apply_lifecycle_record_changes: a lifecycle command
  -- carries no submitted values, selected group or action, so the named-action
  -- entry can never reach a lifecycle write under an action identity.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the receipt fingerprint, the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed Rule the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
          );
          select item.value into root_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text);
          select item.value into root_snapshot
          from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
          where item.value ->> 'recordKey' = 'root';
          if root_type is null or root_snapshot is null then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
          for relationship_value, target_type in
            select item.value, target.value
            from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
            join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
              on vortex_record.relationship_declares_target_internal(
                item.value, (target.value ->> 'recordTypeId')::uuid
              )
            where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
            order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
          loop
            relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
            old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
            proposed_relationship_target := old_relationship_target;
            if p_submitted_values ? relationship_field_id then
              proposed_relationship_target := p_submitted_values -> relationship_field_id;
            end if;
            if not (
              (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
                pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
              or
              (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
                pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
            ) then
              continue;
            end if;
            for total_field in
              select field.value
              from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
              where field.value ->> 'type' = 'total'
                and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                  pg_catalog.lower(relationship_value ->> 'relationshipId')
            loop
              if p_submitted_values ? relationship_field_id and
                p_submitted_values -> relationship_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
              dependency_contract := vortex_record.total_dependency_contract_internal(
                catalogue -> 'recordTypes',
                pg_catalog.jsonb_build_array(relationship_value),
                (target_type ->> 'recordTypeId')::uuid, total_field
              );
              for dependency_field_id in
                select item.value
                from pg_catalog.jsonb_array_elements_text(
                  dependency_contract -> 'sourceFieldIds'
                ) item(value)
              loop
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
                    coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                  contributes_to_total := true;
                  exit;
                end if;
              end loop;
              exit when contributes_to_total;
            end loop;
            exit when contributes_to_total;
          end loop;
          if contributes_to_total then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
        end if;
      end if;

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
          preparation_value := null;
        else
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      else
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.lower(field.value ->> 'fieldId')
                order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
              )
              from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
              where field.value ->> 'type' in ('total', 'calculation')
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into expected_parents
        from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
              from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into supplied_parents
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
      or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
      p_command_id, action_owner_kind, action_owner_id,
      action_release_revision, action_id_value, p_record_type_id, p_record_id,
      p_expected_concurrency_number, action_inputs
    );
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, 'named_action', command_fingerprint_value,
      p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
        'actionOwnerKind', action_owner_kind,
        'actionOwnerId', action_owner_id,
        'actionReleaseRevision', action_release_revision,
        'actionId', action_id_value
      ), '{}'::jsonb, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'completed'
    );
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, null, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
      p_command_id, action_owner_kind, action_owner_id,
      action_release_revision, action_id_value, p_record_type_id, p_record_id,
      p_expected_concurrency_number, action_inputs
    );
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, 'named_action', command_fingerprint_value,
      p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
        'actionOwnerKind', action_owner_kind,
        'actionOwnerId', action_owner_id,
        'actionReleaseRevision', action_release_revision,
        'actionId', action_id_value
      ), '{}'::jsonb, false
    );
  else
    command_fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_selected_group_id
    );
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, p_operation, command_fingerprint_value,
      p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if preview_installation is not null
    and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
    perform vortex_record.release_command_receipt_internal(
      receipt_kind, effective_command_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_relationship_refused'
    );
  end if;

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
      );
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
        );
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place replaces the per-writer #858 corrections.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    elsif not action_mode
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    elsif action_mode
      and p_operation = 'update'
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0
      and creation_count = 0
      and pg_catalog.jsonb_typeof(action_parents) = 'array'
      and pg_catalog.jsonb_array_length(action_parents) = 0
      and (case
        when copy_plan is null then true
        when pg_catalog.jsonb_typeof(copy_plan) = 'object'
          and copy_plan ->> 'outcome' = 'planned'
          and pg_catalog.jsonb_typeof(copy_plan -> 'copies') = 'array'
          then pg_catalog.jsonb_array_length(copy_plan -> 'copies') = 0
        else false
      end)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
        where task.value ->> 'type' = 'record.delete'
      ) then
      -- The named declaration and proposed graph already passed their protected
      -- decisions and target locks. Save one actual subject tuple before edges.
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
           definition_revision = $4
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number',
        loaded ->> 'table'
      ) into saved_record_id, saved_concurrency_number
      using organization_id_value, p_record_id, actor_id_value,
        (loaded ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
      get diagnostics changed_rows = row_count;
      if changed_rows <> 1 then
        raise exception using errcode = '40001',
          message = 'Named relationship change did not apply to exactly one row';
      end if;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named relationship saved identity is unavailable';
      end if;
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', saved_record_id,
        'concurrencyNumber', saved_concurrency_number
      );
      named_relationship_subject_saved := true;
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_named_action_activity_internal(
      p_activity_id, saved_record_id, changed_field_ids, 'completed'
    );
  elsif preview_installation is null then
    activity_time := vortex_record.append_base_save_activity_internal(
      p_activity_id, p_operation, saved_record_id,
      changed_field_ids, 'completed'
    );
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_event.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid,
      saved_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', p_record_type_id
        ),
        'payload', event_payload
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := vortex_record.read_record(p_record_type_id, saved_record_id);
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_invalidation.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- Reauthorize the complete new graph before any created-row Activity or
    -- Event is visible. This barrier is intentionally whole-command, not per row.
    first_created_record_tuples :=
      vortex_record.authorize_created_records_for_command_internal(
        action_creations, created_records, original_context_value
      );
    if pg_catalog.jsonb_typeof(first_created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(first_created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;

    -- Append each created-row Activity and its standard Event only after the
    -- complete set passed ordinary CREATE authorization.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_event.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_typeof(event_result -> 0) is distinct from 'object'
        or event_result -> 0 ->> 'occurrenceId' is distinct from occurrence_id_value::text then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;

  if creation_count > 0 then
    -- Re-load and reauthorize the entire graph after every mandatory created-row,
    -- copy and parent effect. These actual final target tuples drive both receipt
    -- completion and the narrow advisory created-notice attempts below.
    created_record_tuples := vortex_record.authorize_created_records_for_command_internal(
      action_creations, created_records, original_context_value
    );
    if pg_catalog.jsonb_typeof(created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    for final_created_tuple in
      select item.value
      from pg_catalog.jsonb_array_elements(created_record_tuples) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(final_created_tuple) is distinct from 'object'
        or not (final_created_tuple ?& array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ])
        or final_created_tuple - array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ]::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'ordinal') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'ordinal', 'integer'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'concurrencyNumber') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'concurrencyNumber', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'organizationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'organizationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') not in ('string', 'null')
        or (pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') = 'string'
          and coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'applicationRootId', 'uuid'), true))
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleRootId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleRootId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordTypeId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordTypeId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageContractId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'storageContractId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleReleaseRevision') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageScope') is distinct from 'string'
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'correlationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'correlationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'eligible') is distinct from 'boolean' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is malformed';
      end if;
      created_ordinal := (final_created_tuple ->> 'ordinal')::integer;
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      if created_ordinal < 1
        or created_ordinal = any (seen_created_ordinals)
        or created_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or created_record_id = any (seen_created_ids)
        or created_concurrency_number not between 1 and 9007199254740991
        or (final_created_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or (final_created_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
        or (final_created_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
        or (final_created_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
        or ((final_created_tuple ->> 'storageScope') = 'application_contained'
          and (final_created_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
        or ((final_created_tuple ->> 'storageScope') = 'organization_shared'
          and final_created_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
        or (final_created_tuple ->> 'eligible')::boolean is distinct from
          ((final_created_tuple ->> 'storageScope') = 'application_contained') then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is invalid';
      end if;
      inserted_value := created_records -> created_ordinal::text;
      saved_tuple := inserted_value -> '_savedTuple';
      if inserted_value is null
        or final_created_tuple -> 'recordId' is distinct from inserted_value -> 'recordId'
        or final_created_tuple -> 'organizationId' is distinct from saved_tuple -> 'organizationId'
        or final_created_tuple -> 'applicationRootId' is distinct from saved_tuple -> 'applicationRootId'
        or final_created_tuple -> 'moduleRootId' is distinct from saved_tuple -> 'moduleRootId'
        or final_created_tuple -> 'recordTypeId' is distinct from saved_tuple -> 'recordTypeId'
        or final_created_tuple -> 'storageContractId' is distinct from saved_tuple -> 'storageContractId'
        or final_created_tuple -> 'moduleReleaseRevision' is distinct from saved_tuple -> 'moduleReleaseRevision'
        or final_created_tuple -> 'storageScope' is distinct from saved_tuple -> 'storageScope'
        or final_created_tuple -> 'correlationId' is distinct from saved_tuple -> 'correlationId'
        or final_created_tuple -> 'eligible' is distinct from saved_tuple -> 'eligible' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple changed';
      end if;
      seen_created_ordinals := pg_catalog.array_append(seen_created_ordinals, created_ordinal);
      seen_created_ids := pg_catalog.array_append(seen_created_ids, created_record_id);
      public_created_records := public_created_records || pg_catalog.jsonb_build_object(
        created_ordinal::text, pg_catalog.jsonb_build_object(
          'recordId', inserted_value -> 'recordId',
          'storageContractId', inserted_value -> 'storageContractId',
          'values', inserted_value -> 'values'
        )
      );
    end loop;
    if pg_catalog.cardinality(seen_created_ordinals) <> creation_count
      or pg_catalog.cardinality(seen_created_ids) <> creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation set is incomplete';
    end if;

    if not named_action_receipt_pending then
      raise exception using errcode = '55000',
        message = 'Named action receipt completion is unavailable';
    end if;
    if named_action_receipt_subject_write then
      if saved_record_id is null
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named action receipt completion tuple is unavailable';
      end if;
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, saved_record_id, saved_concurrency_number,
        'Record save receipt is stale'
      );
    else
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, null, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    end if;
    named_action_receipt_pending := false;
  end if;

  -- Only the new created-row notice attempt is advisory. All tuple and context
  -- validation above is outside this per-tuple catch; allocation, safe sequence
  -- validation and exact publication share one narrow failure boundary.
  for final_created_tuple in
    select item.value from pg_catalog.jsonb_array_elements(created_record_tuples) item(value)
  loop
    if (final_created_tuple ->> 'eligible')::boolean then
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Created Record notice sequence is unavailable';
        end if;
        perform vortex_invalidation.publish_change_notice(
          organization_id_value, application_root_id_value,
          (final_created_tuple ->> 'recordTypeId')::uuid,
          created_record_id, created_concurrency_number, 'created',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  if named_relationship_subject_saved then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_invalidation.publish_change_notice(
        organization_id_value, application_root_id_value, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Invalidation is advisory after the protected named action is complete.
      null;
    end;
  end if;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', public_created_records);
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one live or preview-local receipt and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

-- Retire the former per-row creation authorization helper; the dispatcher now consumes the complete-set helper.
drop function vortex_record.authorize_named_action_created_record_internal(uuid,uuid,uuid[]);

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
