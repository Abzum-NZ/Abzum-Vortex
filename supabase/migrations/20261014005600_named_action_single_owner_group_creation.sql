set local role vortex_owner;

create or replace function vortex_access.list_current_record_owner_groups()
returns table (group_id uuid, label text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();

  return query
  select distinct organization_group.group_id, organization_group.label
  from vortex_access.organization_groups as organization_group
  join vortex_access.organization_group_memberships as membership
    on membership.organization_id = organization_group.organization_id
    and membership.group_id = organization_group.group_id
  where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
    and organization_group.state = 'active'
    and membership.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and membership.state = 'live'
    and membership.starts_at <= pg_catalog.statement_timestamp()
    and (membership.expires_at is null
      or membership.expires_at > pg_catalog.statement_timestamp())
  order by organization_group.label, organization_group.group_id;
end
$function$;

revoke all on function vortex_access.list_current_record_owner_groups()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_current_record_owner_groups()
  to vortex_request, vortex_record_adapter;

comment on function vortex_access.list_current_record_owner_groups() is
  'Returns only the active Groups of which the verified current organisation account is a current member, for an explicit initial record ownership choice. The protected Record writer rechecks the selected Group under its own transaction lock.';

alter function vortex_access.list_current_record_owner_groups() owner to vortex_owner;

grant execute on function vortex_access.list_current_record_owner_groups() to postgres;

set local role vortex_record_adapter;

create or replace function vortex_record.named_action_creation_plan_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  task_value jsonb;
  task_ordinal integer;
  target_type_id uuid;
  target_meta jsonb;
  target_type jsonb;
  ownership_mode text;
  owner_group_count integer;
  ownership_relationship jsonb;
  ownership_field jsonb;
  ownership_field_id text;
  field_key text;
  field_value jsonb;
  relationship_value jsonb;
  create_targets jsonb := '[]'::jsonb;
  supplied jsonb;
  expected_plan jsonb := '[]'::jsonb;
  supplied_plan jsonb := '[]'::jsonb;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- #569: a create-bearing command may also change the subject's own links.
  -- The inversion this used to guard against (the subject's relationship edge
  -- identities L6 before a created record's reference-number counter L4 and
  -- data version) is closed by the terminal writer, which reserves every
  -- creation's counters and every affected data version before the subject
  -- writer runs.

  for task_value, task_ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if task_value ->> 'type' <> 'record.create' then continue; end if;
    if task_value #>> '{properties,recordType,state}' is distinct from 'resolved'
      or not pg_catalog.pg_input_is_valid(
        task_value #>> '{properties,recordType,recordTypeId}', 'uuid'
      )
      or pg_catalog.jsonb_typeof(task_value -> 'properties' -> 'values') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    target_type_id := (task_value #>> '{properties,recordType,recordTypeId}')::uuid;
    target_meta := vortex_record.resolve_record_action_context_internal(
      target_type_id, 'create'
    );
    target_type := target_meta -> 'recordType';
    if pg_catalog.jsonb_typeof(target_type) <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    ownership_mode := target_type ->> 'ownershipMode';

    -- A named action has no owner Group selection. A single live Group
    -- membership identifies its owner without trusting a caller-supplied ID.
    -- The insert phase checks the same membership again under a lock.
    if ownership_mode = 'group' then
      select pg_catalog.count(*) into owner_group_count
      from vortex_access.list_current_record_owner_groups();
      if owner_group_count <> 1 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', case when owner_group_count = 0
            then 'create_target_owner_unavailable'
            else 'create_target_owner_ambiguous' end
        );
      end if;
    end if;
    -- Refusal 2: an `inherited` target derives its owner from one declared
    -- relationship. Authored values name its source field, not its identity.
    if ownership_mode = 'inherited' then
      if pg_catalog.pg_input_is_valid(
          target_type ->> 'ownershipRelationshipId', 'uuid'
        ) is distinct from true
        or pg_catalog.jsonb_typeof(target_type -> 'relationships') is distinct from 'array'
        or pg_catalog.jsonb_typeof(target_type -> 'fields') is distinct from 'array' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;

      select item.value into strict ownership_relationship
      from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') = pg_catalog.lower(
        target_type ->> 'ownershipRelationshipId'
      );
      if pg_catalog.pg_input_is_valid(
          ownership_relationship ->> 'fromRecordTypeId', 'uuid'
        ) is distinct from true
        or pg_catalog.lower(ownership_relationship ->> 'fromRecordTypeId')
          is distinct from target_type_id::text
        or pg_catalog.pg_input_is_valid(
          ownership_relationship ->> 'fromFieldId', 'uuid'
        ) is distinct from true then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;

      ownership_field_id := pg_catalog.lower(ownership_relationship ->> 'fromFieldId');
      select item.value into strict ownership_field
      from pg_catalog.jsonb_array_elements(target_type -> 'fields') item(value)
      where pg_catalog.lower(item.value ->> 'fieldId') = ownership_field_id;
      if (ownership_field ->> 'type' in ('link', 'link_to_one_of_several'))
          is distinct from true
        or (ownership_relationship ->> 'cardinality' in ('one_to_one', 'many_to_one'))
          is distinct from true
        or not (ownership_relationship ? case ownership_field ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or (select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
          where pg_catalog.lower(item.value ->> 'fromFieldId') = ownership_field_id) <> 1 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_relationship_unsupported'
        );
      end if;
      if not (task_value -> 'properties' -> 'values') ? ownership_field_id then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;
    end if;

    for field_key in
      select pg_catalog.lower(item.value)
      from pg_catalog.jsonb_object_keys(task_value -> 'properties' -> 'values') item(value)
    loop
      select item.value into field_value
      from pg_catalog.jsonb_array_elements(target_type -> 'fields') item(value)
      where pg_catalog.lower(item.value ->> 'fieldId') = field_key;
      if field_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_field_unknown'
        );
      end if;
      if field_value ->> 'type' = 'reference_number' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_generated_field'
        );
      end if;
      -- Refusal 3: only to-one link semantics are implemented. A link names its
      -- single declared target and a link to one of several record types its
      -- declared list; the edge writer proves the concrete target a member.
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into relationship_value
        from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
        where pg_catalog.lower(item.value ->> 'fromFieldId') = field_key;
        if relationship_value is null
          or not (relationship_value ? case field_value ->> 'type'
            when 'link' then 'toRecordType' else 'toRecordTypes' end)
          or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
          return pg_catalog.jsonb_build_object(
            'outcome', 'unsupported', 'reasonCode', 'create_target_relationship_unsupported'
          );
        end if;
      end if;
    end loop;

    create_targets := create_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', task_ordinal,
        'recordTypeId', target_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_meta ->> 'storageScope',
        'ownershipMode', ownership_mode,
        'recordType', target_type,
        'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
          (target_meta ->> 'moduleRootId')::uuid,
          (target_meta ->> 'moduleReleaseRevision')::bigint,
          target_type_id
        )
      )
    );
    expected_plan := expected_plan || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', task_ordinal,
        'recordTypeId', pg_catalog.lower(target_type_id::text),
        'valueFieldIds', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
          from pg_catalog.jsonb_object_keys(task_value -> 'properties' -> 'values') item(value)
        ), '[]'::jsonb)
      )
    );
  end loop;

  if p_creations is not null then
    if pg_catalog.jsonb_typeof(p_creations) <> 'array' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    for supplied in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(supplied) <> 'object'
        or not (supplied ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
        or pg_catalog.jsonb_typeof(supplied -> 'values') <> 'object'
        or pg_catalog.jsonb_typeof(supplied -> 'finalValues') <> 'object'
        or not pg_catalog.pg_input_is_valid(supplied ->> 'recordTypeId', 'uuid') then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      supplied_plan := supplied_plan || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'ordinal', (supplied ->> 'ordinal')::integer,
          'recordTypeId', pg_catalog.lower((supplied ->> 'recordTypeId')::uuid::text),
          'valueFieldIds', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
            from pg_catalog.jsonb_object_keys(supplied -> 'values') item(value)
          ), '[]'::jsonb)
        )
      );
    end loop;
    if supplied_plan is distinct from expected_plan then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'creation_plan_mismatch'
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'planned', 'createTargets', create_targets
  );
exception
  when no_data_found or too_many_rows then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
    );
end
$function$;

alter function vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb
) is
  'Private named-action step: resolves every record.create task of the installed action against the exact active installation, refuses an unsupported creation shape, and returns the creation plan the command must supply back verbatim.';

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
  owner_group_id uuid;
  owner_group_count integer;
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
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
       pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)
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
    module_release_revision_value, owner_account_id, owner_group_id, actor_id_value;
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
alter function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]) owner to vortex_record_adapter;


alter function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])
  to vortex_record_adapter;

comment on function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]) is
  'Private named-action insert phase: validates current installed create metadata, allocates required reference values before all edges, captures the actual inserted row and revision with RETURNING, and returns a private tuple for whole-graph authorization and terminal created-notice emission.';

reset role;
