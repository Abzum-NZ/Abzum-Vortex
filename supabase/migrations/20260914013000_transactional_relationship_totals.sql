-- #48 Stage 2B: maintain concrete relationship totals inside the existing
-- protected create/update transaction. These helpers are deliberately private
-- to the Record adapter/runtime and do not form a related-record read API.
begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.relationship_total_catalogue_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  installation jsonb;
  binding jsonb;
  content jsonb;
  record_types jsonb := '[]'::jsonb;
  relationships jsonb := '[]'::jsonb;
  has_installed_rules boolean := false;
  record_type jsonb;
begin
  installation := vortex_module.read_current_active_installation();
  for binding in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.compilation_output #> '{canonical,content}' into strict content
    from vortex_definition.releases release
    where release.root_id = (binding ->> 'moduleRootId')::uuid
      and release.release_revision = (binding ->> 'moduleReleaseRevision')::bigint;
    if pg_catalog.jsonb_typeof(content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000', message = 'Installed Record definitions are unavailable';
    end if;
    has_installed_rules := has_installed_rules or
      pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
    record_types := record_types || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'moduleReleaseRevision', binding -> 'moduleReleaseRevision'
        )
        order by item.value ->> 'recordTypeId'
      )
      from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    ), '[]'::jsonb);
    for record_type in
      select item.value from pg_catalog.jsonb_array_elements(content -> 'recordTypes') item(value)
    loop
      relationships := relationships || coalesce(record_type -> 'relationships', '[]'::jsonb);
    end loop;
  end loop;
  select release.compilation_output #> '{canonical,content}' into strict content
  from vortex_definition.releases release
  where release.root_id = (installation ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  has_installed_rules := has_installed_rules or
    pg_catalog.jsonb_array_length(coalesce(content -> 'rules', '[]'::jsonb)) > 0;
  return pg_catalog.jsonb_build_object(
    'recordTypes', record_types,
    'relationships', relationships,
    'hasInstalledRules', has_installed_rules
  );
end
$function$;

create function vortex_record.relationship_total_record_snapshot_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  columns_value jsonb;
  value_expression text;
  load_sql text;
  result_value jsonb;
begin
  if p_record_type_id is null or p_record_id is null or p_lock is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return null; end if;

  select stored.* into catalogue_row
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then return null; end if;

  select pg_catalog.jsonb_object_agg(
    pg_catalog.lower(field.value ->> 'fieldId'),
    pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type,
      'type', field.value ->> 'type'
    )
  ) into columns_value
  from pg_catalog.jsonb_array_elements(record_type -> 'fields') field(value)
  join vortex_record.field_storage_mappings mapping
    on mapping.storage_contract_id = (record_type ->> 'storageContractId')::uuid
   and mapping.field_id = (field.value ->> 'fieldId')::uuid
   and mapping.state = 'active';
  if (select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(coalesce(columns_value, '{}'::jsonb))) <>
      pg_catalog.jsonb_array_length(record_type -> 'fields') then
    return null;
  end if;

  select pg_catalog.string_agg(
    pg_catalog.format(
      '%L, %s', entry.key,
      case entry.value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', entry.value ->> 'token')
        when 'timestamp_with_time_zone' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.%I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
          entry.value ->> 'token'
        )
        when 'date' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
          entry.value ->> 'token'
        )
        else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', entry.value ->> 'token')
      end
    ), ', ' order by entry.key collate "C"
  ) into value_expression
  from pg_catalog.jsonb_each(columns_value) entry(key, value);

  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordType'', $3 - ''moduleReleaseRevision'',
       ''recordTypeId'', %L::uuid,
       ''storageContractId'', %L::uuid,
       ''recordId'', stored.record_id,
       ''concurrencyNumber'', stored.concurrency_number,
       ''definitionRevision'', %L::bigint,
       ''existingValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
     )
     from record_data.%I stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active''
       and stored.application_root_id is not distinct from %s%s',
    p_record_type_id,
    (record_type ->> 'storageContractId')::uuid,
    (record_type ->> 'moduleReleaseRevision')::bigint,
    value_expression,
    catalogue_row.physical_table_token,
    case when record_type ->> 'storageScope' = 'application_contained'
      then '$4::uuid' else 'null::uuid' end,
    case when p_lock then ' for update' else '' end
  );
  execute load_sql into result_value using
    (context_value ->> 'organizationId')::uuid,
    p_record_id,
    record_type,
    (context_value ->> 'applicationRootId')::uuid;
  return result_value;
end
$function$;

create function vortex_record.discover_relationship_total_closure_internal(
  p_catalogue jsonb,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_submitted_values jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  root_type jsonb;
  root_snapshot jsonb;
  records jsonb := '[]'::jsonb;
  signatures jsonb := '[]'::jsonb;
  queued_keys text[] := array[]::text[];
  queue_index integer := 0;
  current_record jsonb;
  current_key text;
  relationship jsonb;
  field_id text;
  old_target jsonb;
  proposed_target jsonb;
  target jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_type jsonb;
  target_key text;
  target_snapshot jsonb;
begin
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return null; end if;
  if p_operation = 'update' then
    root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
      p_catalogue, p_record_type_id, p_record_id, false
    );
    if root_snapshot is null then return null; end if;
  else
    root_snapshot := pg_catalog.jsonb_build_object(
      'recordType', root_type - 'moduleReleaseRevision',
      'recordTypeId', p_record_type_id,
      'storageContractId', (root_type ->> 'storageContractId')::uuid,
      'existingValues', '{}'::jsonb
    );
  end if;
  root_snapshot := root_snapshot || pg_catalog.jsonb_build_object('recordKey', 'root');
  records := pg_catalog.jsonb_build_array(root_snapshot);
  queued_keys := array['root'];

  while queue_index < pg_catalog.cardinality(queued_keys) loop
    if queue_index >= 256 then
      raise exception using errcode = '54001', message = 'Relationship total dependency closure is too large';
    end if;
    current_key := queued_keys[queue_index + 1];
    queue_index := queue_index + 1;
    select item.value into strict current_record
    from pg_catalog.jsonb_array_elements(records) item(value)
    where item.value ->> 'recordKey' = current_key;

    for relationship in
      select item.value
      from pg_catalog.jsonb_array_elements(current_record -> 'recordType' -> 'relationships') item(value)
      where item.value ? 'toRecordType'
        and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
      order by item.value ->> 'relationshipId'
    loop
      field_id := pg_catalog.lower(relationship ->> 'fromFieldId');
      old_target := current_record -> 'existingValues' -> field_id;
      proposed_target := old_target;
      if current_key = 'root' and p_submitted_values ? field_id then
        proposed_target := p_submitted_values -> field_id;
      end if;
      for target in
        select distinct_candidate.value
        from (
          select distinct candidate.value
          from pg_catalog.jsonb_array_elements(
            pg_catalog.jsonb_build_array(old_target, proposed_target)
          ) candidate(value)
          where pg_catalog.jsonb_typeof(candidate.value) = 'object'
        ) distinct_candidate
        order by distinct_candidate.value::text collate "C"
      loop
        if not pg_catalog.pg_input_is_valid(target ->> 'recordTypeId', 'uuid')
          or not pg_catalog.pg_input_is_valid(target ->> 'recordId', 'uuid') then
          return null;
        end if;
        target_type_id := (target ->> 'recordTypeId')::uuid;
        target_record_id := (target ->> 'recordId')::uuid;
        if target_type_id <> (relationship #>> '{toRecordType,recordTypeId}')::uuid then
          return null;
        end if;
        select item.value into target_type
        from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(target_type_id::text);
        if target_type is null or not exists (
          select 1 from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
          where field.value ->> 'type' = 'total'
            and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
              pg_catalog.lower(relationship ->> 'relationshipId')
        ) then
          continue;
        end if;
        target_key := case
          when p_operation = 'update' and target_type_id = p_record_type_id
            and target_record_id = p_record_id then 'root'
          else pg_catalog.lower(target_type_id::text) || ':' || pg_catalog.lower(target_record_id::text)
        end;
        signatures := signatures || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'from', current_key,
          'relationshipId', relationship -> 'relationshipId',
          'to', target_key
        ));
        if not (target_key = any(queued_keys)) then
          target_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            p_catalogue, target_type_id, target_record_id, false
          );
          if target_snapshot is null then return null; end if;
          records := records || pg_catalog.jsonb_build_array(
            target_snapshot || pg_catalog.jsonb_build_object('recordKey', target_key)
          );
          queued_keys := pg_catalog.array_append(queued_keys, target_key);
        end if;
      end loop;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) item(value)
    ), '[]'::jsonb)
  );
end
$function$;

create function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  access_loaded jsonb;
  access_decision jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_operation not in ('create', 'update')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'update' and p_selected_group_id is not null)
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  -- Receipt resolution remains owned by prepare_base_record_save. Merely seeing
  -- an existing identity here avoids dependency reads or locks on replays and
  -- changed-input duplicates.
  if exists (
    select 1 from vortex_record.save_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(root_type -> 'fields') field(value)
    where field.value ->> 'type' = 'total'
  ) and pg_catalog.jsonb_array_length(root_type -> 'relationships') = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  -- Authorize the old source without a row lock before discovering or locking
  -- any concrete dependency. A denied update is deferred to the base prepare,
  -- which owns the existing content-free refusal Activity.
  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, null
    );
    if access_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'defer');
    end if;
    if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', context_organization_id,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);
  end if;

  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if before_closure is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;

  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if after_closure is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- A concurrent exact or changed-input duplicate may have completed while
  -- this transaction waited for the source/parent locks. Let the existing
  -- receipt owner distinguish replay from command-identity conflict.
  if exists (
    select 1 from vortex_record.save_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if p_operation = 'update' and (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if access_loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);
  end if;

  -- Materialize only the declared aggregate sources for each locked affected
  -- record. The initial source's proposed move replaces its old membership in
  -- this transaction-visible snapshot.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and pg_catalog.lower(item.value #>> '{toRecordType,recordTypeId}') =
          pg_catalog.lower(prepared_record ->> 'recordTypeId');
      if relationship_value is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then proposed_target := p_submitted_values -> source_field_id; end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when no_data_found or too_many_rows or check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

create function vortex_record.apply_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  catalogue jsonb;
  snapshot jsonb;
  context_value jsonb;
  field_value jsonb;
  column_value jsonb;
  entry record;
  assignments text[] := array[]::text[];
  changed_field_ids uuid[] := array[]::uuid[];
  update_sql text;
  new_revision bigint;
  event_result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Relationship total parent mutation is invalid';
  end if;
  if p_final_values = '{}'::jsonb then return; end if;
  catalogue := vortex_record.relationship_total_catalogue_internal();
  snapshot := vortex_record.relationship_total_record_snapshot_internal(
    catalogue, p_record_type_id, p_record_id, true
  );
  if snapshot is null or (snapshot ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    raise exception using errcode = '40001', message = 'Relationship total parent revision changed';
  end if;
  context_value := vortex_access.validated_human_request_context();
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(snapshot -> 'recordType' -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Relationship total parent field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = (snapshot ->> 'storageContractId')::uuid
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Relationship total parent value is invalid';
    end if;
    assignments := pg_catalog.array_append(assignments, pg_catalog.format(
      '%I = %s', column_value ->> 'token',
      case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
      else case column_value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
        when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
        when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
        when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
        when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
        when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
        else pg_catalog.format('%L::text', entry.value #>> '{}') end end
    ));
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);
  update_sql := pg_catalog.format(
    'update record_data.%I stored set %s,
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $4
     returning stored.concurrency_number',
    (select stored.physical_table_token from vortex_record.storage_catalogue stored
     where stored.storage_contract_id = (snapshot ->> 'storageContractId')::uuid),
    pg_catalog.array_to_string(assignments, ', ')
  );
  execute update_sql into new_revision using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid, p_expected_concurrency_number,
    (snapshot ->> 'definitionRevision')::bigint;
  if new_revision is null then
    raise exception using errcode = '40001', message = 'Relationship total parent write is stale';
  end if;
  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (snapshot ->> 'storageContractId')::uuid,
    case when snapshot #>> '{recordType,storageScope}' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end
  );
  perform vortex_record.append_base_save_activity_internal(
    pg_catalog.gen_random_uuid(), 'update', p_record_id, changed_field_ids, 'completed'
  );
  event_result := vortex_event.append_record_occurrences(
    (snapshot ->> 'storageContractId')::uuid, p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', pg_catalog.gen_random_uuid(),
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Relationship total parent Event append failed';
  end if;
end
$function$;

create function vortex_record.save_base_record_with_relationship_totals(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  preparation_value jsonb;
  reduced_final_values jsonb;
  context_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Receipt identity remains authoritative for replay and changed-input
  -- duplicate classification. A completed command must reach that owner even
  -- if a caller supplies no longer-current relationship mutations.
  if not exists (
    select 1 from vortex_record.save_command_receipts receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
    -- The writer repeats the protected preparation itself.  Closure identity,
    -- revisions and the complete generated-field set therefore never depend
    -- on caller-controlled transaction state or a replayable preparation token.
    preparation_value := vortex_record.prepare_relationship_total_save(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_selected_group_id,
      p_activity_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' <> 'prepared' then
      if pg_catalog.jsonb_array_length(p_parent_mutations) = 0 then
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
      where item.value ->> 'recordKey' <> 'root';
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
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) = 'object'
        and item.value ?& array[
          'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
        ]
        and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
      if supplied_parents is distinct from expected_parents
        or pg_catalog.jsonb_array_length(supplied_parents) <>
          pg_catalog.jsonb_array_length(p_parent_mutations) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    end if;
  end if;
  result_value := vortex_record.save_base_record(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_final_values,
    p_selected_group_id, p_activity_id, p_occurrence_id
  );
  if result_value ->> 'outcome' <> 'saved' or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;
  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023', message = 'Relationship total parent mutation is incomplete';
    end if;
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
  return result_value;
end
$function$;

alter function vortex_record.relationship_total_catalogue_internal() owner to vortex_record_adapter;
alter function vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean) owner to vortex_record_adapter;
alter function vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb) owner to vortex_record_adapter;
alter function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;
alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;
alter function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.relationship_total_catalogue_internal(),
  vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean),
  vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb),
  vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid),
  vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb),
  vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid),
  vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
to vortex_runtime;
revoke execute on function vortex_record.save_base_record(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid)
from vortex_runtime;
grant execute on function vortex_record.relationship_total_catalogue_internal(),
  vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean),
  vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb),
  vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
to vortex_record_adapter;

comment on function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) is
  'Private Stage 2B preflight: discovers old/proposed concrete total closure, locks it canonically, re-reads it, and returns only declared evaluator inputs.';
comment on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) is
  'Existing protected base save composed with revision-checked generated parent totals, Activity and standard Events in the same transaction.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
