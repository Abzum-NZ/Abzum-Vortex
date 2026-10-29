create or replace function vortex_record.prepare_named_action_record_create_internal(
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
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  owner_group_count integer;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := p_final_values;
  physical_values jsonb := '{}'::jsonb;
  storage_change jsonb;
  app_scope uuid;
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
    select pg_catalog.count(*), (pg_catalog.array_agg(group_id))[1]
    into owner_group_count, owner_group_id
    from vortex_access.list_current_record_owner_groups();
    if owner_group_count <> 1 then
      raise exception using errcode = '42501',
        message = case when owner_group_count = 0
          then 'Named action creation owner is unavailable'
          else 'Named action creation owner is ambiguous' end;
    end if;
    if not vortex_access.lock_current_record_owner_group_internal(owner_group_id) then
      raise exception using errcode = '42501',
        message = 'Named action creation owner is unavailable';
    end if;
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

    physical_values := physical_values || pg_catalog.jsonb_build_object(
      column_value ->> 'token', input_value
    );
  end loop;

  storage_change := pg_catalog.jsonb_build_object(
    'storageContractId', storage_contract_id_value, 'recordId', record_id_value,
    'expectedConcurrencyNumber', null,
    'values', physical_values || pg_catalog.jsonb_build_object(
      'module_root_id', module_root_id_value, 'record_type_id', p_record_type_id,
      'storage_contract_id', storage_contract_id_value, 'application_root_id', app_scope,
      'definition_revision', module_release_revision_value,
      'owner_organisation_account_id', owner_account_id, 'owner_group_id', owner_group_id,
      'lifecycle_state', 'active', 'created_at', pg_catalog.statement_timestamp(),
      'created_by', actor_id_value
    )
  );

  eligible_for_created_notice := storage_scope_value = 'application_contained';
  return pg_catalog.jsonb_build_object(
    'recordId', record_id_value,
    'storageContractId', storage_contract_id_value,
    'values', final_values, 'storageChange', storage_change,
    '_savedTuple', pg_catalog.jsonb_build_object(
      'recordId', record_id_value,
      'concurrencyNumber', 1,
      'organizationId', organization_id_value,
      'applicationRootId', app_scope,
      'moduleRootId', module_root_id_value,
      'recordTypeId', p_record_type_id,
      'storageContractId', storage_contract_id_value,
      'moduleReleaseRevision', module_release_revision_value,
      'storageScope', storage_scope_value,
      'actorId', actor_id_value,
      'correlationId', (context_value ->> 'correlationId')::uuid,
      'eligible', eligible_for_created_notice
    )
  );
end
$function$;
alter function vortex_record.prepare_named_action_record_create_internal(uuid,jsonb,uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_record_create_internal(uuid,jsonb,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_record_create_internal(uuid,jsonb,uuid[])
  to vortex_record_adapter;

comment on function vortex_record.prepare_named_action_record_create_internal(uuid,jsonb,uuid[]) is
  'Private named-action create preparation: validates definition, typed values and derived ownership, allocates references, and returns a storage mutation and expected tuple for the whole-command authority check.';
