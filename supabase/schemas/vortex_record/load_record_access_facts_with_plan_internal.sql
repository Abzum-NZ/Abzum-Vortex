create or replace function vortex_record.load_record_access_facts_with_plan_internal(
  p_action_kind text,
  p_targets jsonb,
  p_installation jsonb,
  p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  plan jsonb;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  target_count integer;
  -- Per target (1-based, in the caller's order).
  target_type_ids uuid[];
  target_record_ids uuid[];
  target_expected_numbers bigint[];
  target_results jsonb[];
  target_facts jsonb[];
  target_reached text[];
  target_edges jsonb[];
  -- Per record type of the call: the declaration and the projection source.
  declarations jsonb := '{}'::jsonb;
  required_by_type jsonb := '{}'::jsonb;
  sources jsonb := '{}'::jsonb;
  type_item record;
  group_item record;
  target_meta jsonb;
  target_scope text;
  target_module_root_id uuid;
  target_is_system_projection boolean;
  preview_target boolean;
  target_source_sql text;
  target_projection_definition jsonb;
  target_projection_sort_key text;
  projection_reader_sql text;
  required_permissions jsonb;
  declaration jsonb;
  selected_field_ids jsonb;
  selected_fields jsonb;
  selected_value_expression text;
  load_sql text;
  loaded_row record;
  target_index integer;
  -- The closure: one shared cache of the related rows it loads, and per wave
  -- one edge query for every (target, record, permission) pair still to expand.
  closure_records jsonb := '{}'::jsonb;
  seen_pairs text[] := array[]::text[];
  wave_targets integer[] := array[]::integer[];
  wave_records uuid[] := array[]::uuid[];
  wave_permissions uuid[] := array[]::uuid[];
  next_targets integer[];
  next_records uuid[];
  next_permissions uuid[];
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  current_contract uuid;
  current_meta jsonb;
  edge_item record;
  loaded_records jsonb;
  record_types_fact jsonb;
  relationships_fact jsonb;
  results jsonb;
begin
  -- Step 1: the targets. One record type, record identity, optional expected
  -- revision, optional protected projection row and optional requested fields
  -- each; a record is named once per call.
  if p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore', 'transfer')
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) not between 1 and 200
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not (target.value ?& array['recordTypeId', 'recordId'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(case
            when pg_catalog.jsonb_typeof(target.value) = 'object' then target.value
            else '{}'::jsonb end) as supplied(key)
          where supplied.key <> all (array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'projectionRow',
            'requestedFieldIds'
          ])
        )
        or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordTypeId')
        or not vortex_platform.is_non_nil_uuid(target.value ->> 'recordId')
        or (pg_catalog.jsonb_typeof(target.value -> 'expectedConcurrencyNumber')
            not in ('null', 'number')
          or (pg_catalog.jsonb_typeof(target.value -> 'expectedConcurrencyNumber') = 'number'
            and ((target.value ->> 'expectedConcurrencyNumber') !~ '^[1-9][0-9]{0,15}$'
              or (target.value ->> 'expectedConcurrencyNumber')::bigint > 9007199254740991)))
        or pg_catalog.jsonb_typeof(target.value -> 'projectionRow') not in ('null', 'object')
        or (pg_catalog.jsonb_typeof(target.value -> 'requestedFieldIds') = 'array'
          and exists (
            select 1 from pg_catalog.jsonb_array_elements(target.value -> 'requestedFieldIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) <> 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ))
        or pg_catalog.jsonb_typeof(target.value -> 'requestedFieldIds') not in ('null', 'array')
    )
    or (
      select pg_catalog.count(*) <> pg_catalog.count(distinct pg_catalog.lower(target.value ->> 'recordId'))
      from pg_catalog.jsonb_array_elements(p_targets) as target(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;
  target_count := pg_catalog.jsonb_array_length(p_targets);
  select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid order by target.ordinality),
    pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by target.ordinality),
    pg_catalog.array_agg((target.value ->> 'expectedConcurrencyNumber')::bigint order by target.ordinality)
  into target_type_ids, target_record_ids, target_expected_numbers
  from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality);
  target_results := pg_catalog.array_fill(null::jsonb, array[target_count]);
  target_facts := pg_catalog.array_fill(null::jsonb, array[target_count]);
  target_reached := pg_catalog.array_fill(null::text, array[target_count]);
  target_edges := pg_catalog.array_fill('[]'::jsonb, array[target_count]);

  -- Step 2: the verified request context, once for the call. The adapter never
  -- reads `current_user`, which is its own owner inside a definer function.
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

  -- Step 3: the exact installation and its access plan, both supplied by the
  -- trusted caller (this internal is not executable by request roles) and
  -- checked once against the verified request context.
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

  -- Step 4: per record type of the call, once: its meta, the protected
  -- projection source and the declaration. Every record-scoped permission of
  -- this action kind declared for the exact record type, owned by the context
  -- Application or by the record type's own Module, in the canonical order the
  -- eligibility core requires.
  for type_item in
    select distinct type_id from pg_catalog.unnest(target_type_ids) as type_id
  loop
    target_meta := type_meta -> pg_catalog.lower(type_item.type_id::text);
    if target_meta is null then
      raise exception using errcode = '55000',
        message = 'Record type is not part of the active installation';
    end if;
    if pg_catalog.jsonb_typeof(target_meta -> 'isSystemProjection')
      is distinct from 'boolean' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;
    target_scope := target_meta ->> 'storageScope';
    target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
    target_is_system_projection := (target_meta ->> 'isSystemProjection')::boolean;

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
      target_projection_sort_key := null;
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
      -- The projection row source is chosen per group below: the reader for
      -- the group's identities, or the rows the caller already read.
      sources := sources || pg_catalog.jsonb_build_object(
        pg_catalog.lower(type_item.type_id::text), pg_catalog.jsonb_build_object(
          'reader', pg_catalog.format(
            'vortex_record.read_system_projection_rows_internal(%L::uuid, $2, %L, ''ascending'', null::jsonb, pg_catalog.cardinality($2), null::jsonb) as projection',
            (target_meta ->> 'storageContractId')::uuid, target_projection_sort_key
          ),
          'source', pg_catalog.format($source$
            /*projection rows*/
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
            target_module_root_id, type_item.type_id,
            (target_meta ->> 'storageContractId')::uuid,
            (target_meta ->> 'releaseRevision')::bigint,
            target_projection_definition #>> '{systemProjection,organizationFieldId}',
            target_projection_definition #>> '{systemProjection,revisionFieldId}',
            target_projection_definition,
            vortex_record.system_projection_columns_internal(target_projection_definition)
          )
        )
      );
    end if;

    -- A preview reads its own copy of every record type except a system
    -- projection: that is the platform's live read model, which a preview reads
    -- on the live path under the reader's own live access, never as the
    -- preview's owner.
    preview_target := p_installation ? 'previewInstallationId' and not target_is_system_projection;

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
    where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(type_item.type_id::text)
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
          'recordTypeId', type_item.type_id,
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
    declarations := declarations || pg_catalog.jsonb_build_object(
      pg_catalog.lower(type_item.type_id::text), coalesce(declaration, 'null'::jsonb)
    );
    required_by_type := required_by_type || pg_catalog.jsonb_build_object(
      pg_catalog.lower(type_item.type_id::text),
      case when declaration is null then '[]'::jsonb else required_permissions end
    );
  end loop;

  -- Step 5: the target rows, one query per record type, requested field set and
  -- projection source. The change path locks them here, in record identity
  -- order, before any other row is read. Organisation and application
  -- isolation is the scope policy's, which is what makes a foreign row
  -- indistinguishable from a missing one.
  for group_item in
    select (target.value ->> 'recordTypeId')::uuid as type_id,
      target.value -> 'requestedFieldIds' as requested_field_ids,
      pg_catalog.jsonb_typeof(target.value -> 'projectionRow') = 'object' as supplied_projection,
      pg_catalog.bool_or(pg_catalog.jsonb_typeof(target.value -> 'expectedConcurrencyNumber') = 'number')
        as locking,
      pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by (target.value ->> 'recordId')::uuid)
        as record_ids,
      pg_catalog.jsonb_agg(target.value -> 'projectionRow') as projection_rows
    from pg_catalog.jsonb_array_elements(p_targets) as target(value)
    group by 1, 2, 3
  loop
    target_meta := type_meta -> pg_catalog.lower(group_item.type_id::text);
    target_scope := target_meta ->> 'storageScope';
    target_is_system_projection := (target_meta ->> 'isSystemProjection')::boolean;
    if target_is_system_projection then
      projection_reader_sql := case when group_item.supplied_projection
        then 'pg_catalog.jsonb_to_recordset($3) as projection(organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)'
        else sources -> pg_catalog.lower(group_item.type_id::text) ->> 'reader' end;
      target_source_sql := pg_catalog.replace(
        sources -> pg_catalog.lower(group_item.type_id::text) ->> 'source',
        '/*projection rows*/', projection_reader_sql
      );
    else
      target_source_sql := pg_catalog.format('record_data.%I as stored', target_meta ->> 'table');
    end if;

    selected_value_expression := target_meta ->> 'valueExpression';
    if pg_catalog.jsonb_typeof(group_item.requested_field_ids) = 'array' then
      -- Access conditions must see the same operands even when no visible placement consumes them.
      -- Read-time calculations also need their stored dependencies, without disclosing those values.
      select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(item.value)), '[]'::jsonb)
      into selected_field_ids
      from (
        select value from pg_catalog.jsonb_array_elements_text(group_item.requested_field_ids)
        union all
        select value #>> '{}' from pg_catalog.jsonb_path_query(condition_list, 'lax $.**.declaredFieldIds[*]') as dependency(value)
        union all
        select dependency.value #>> '{}'
        from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as field(value)
        cross join lateral (values
          (field.value #> '{settings,expression,due,reference,fieldId}'),
          (field.value #> '{settings,expression,status,reference,fieldId}')
        ) as dependency(value)
        where group_item.requested_field_ids ? pg_catalog.lower(field.value ->> 'fieldId')
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
         else ''{}''::jsonb end as fact,
       stored.concurrency_number, stored.definition_revision
       from %s
       where stored.organisation_id = $1 and stored.record_id = any ($2)%s',
      target_scope, (target_meta ->> 'moduleRootId')::uuid, group_item.type_id,
      (target_meta ->> 'storageContractId')::uuid, target_scope,
      selected_value_expression, target_source_sql,
      case when group_item.locking
        then ' order by stored.record_id for update' else '' end
    );

    for loaded_row in execute load_sql
      using context_organization_id, group_item.record_ids, group_item.projection_rows
    loop
      target_index := pg_catalog.array_position(target_record_ids, loaded_row.record_id);
      if target_index is null
        or target_type_ids[target_index] is distinct from group_item.type_id then
        continue;
      end if;
      if target_expected_numbers[target_index] is not null
        and loaded_row.concurrency_number <> target_expected_numbers[target_index] then
        target_results[target_index] := pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'concurrencyNumber', loaded_row.concurrency_number
        );
        continue;
      end if;
      target_facts[target_index] := loaded_row.fact;
      target_reached[target_index] := pg_catalog.lower(loaded_row.record_id::text);
      -- A compatible reprovision can advance the catalogue definition while an
      -- older release remains installed. Report that exact projection
      -- definition; generated records keep their persisted last-written
      -- definition revision.
      target_results[target_index] := pg_catalog.jsonb_build_object(
        'concurrencyNumber', loaded_row.concurrency_number,
        'definitionRevision', case when target_is_system_projection
          then (target_meta ->> 'releaseRevision')::bigint
          else loaded_row.definition_revision end
      );
    end loop;
  end loop;

  -- Step 6: the fact closure, per target. Every loaded target with a
  -- declaration starts one pair per required permission. A (record,
  -- permission) pair of a target is expanded at most once, which bounds the
  -- walk; an inherited-ownership chain is expanded by pushing the parent under
  -- the same permission, so the chase and the relationship routes use the same
  -- mechanism. Each wave reads the edges of all its pairs in one query, and the
  -- related rows it reaches in one query per storage contract.
  select coalesce(pg_catalog.array_agg(started.target_index order by started.target_index, started.ordinality), array[]::integer[]),
    coalesce(pg_catalog.array_agg(target_record_ids[started.target_index] order by started.target_index, started.ordinality), array[]::uuid[]),
    coalesce(pg_catalog.array_agg(started.permission_id order by started.target_index, started.ordinality), array[]::uuid[])
  into wave_targets, wave_records, wave_permissions
  from (
    select indexed.target_index, item.ordinality, (item.value ->> 'permissionId')::uuid as permission_id
    from pg_catalog.generate_subscripts(target_record_ids, 1) as indexed(target_index)
    cross join lateral pg_catalog.jsonb_array_elements(
      required_by_type -> pg_catalog.lower(target_type_ids[indexed.target_index]::text)
    ) with ordinality as item(value, ordinality)
    where target_facts[indexed.target_index] is not null
  ) as started;

  while pg_catalog.cardinality(wave_targets) > 0 loop
    next_targets := array[]::integer[];
    next_records := array[]::uuid[];
    next_permissions := array[]::uuid[];
    for edge_item in
      with wave as (
        select distinct pair.target_position, pair.record_id, pair.permission_id
        from rows from (
          pg_catalog.unnest(wave_targets), pg_catalog.unnest(wave_records),
          pg_catalog.unnest(wave_permissions)
        ) as pair(target_position, record_id, permission_id)
        where pg_catalog.format('%s:%s:%s', pair.target_position,
          pg_catalog.lower(pair.record_id::text), pg_catalog.lower(pair.permission_id::text))
          <> all (seen_pairs)
      ),
      expanded as (
        select wave.target_position, wave.record_id, wave.permission_id,
          type_meta -> pg_catalog.lower(fact.value -> 'recordScope' ->> 'recordTypeId') as meta,
          permission_by_id -> pg_catalog.lower(wave.permission_id::text) -> 'recordScope' as scope
        from wave
        cross join lateral (
          select case when wave.record_id = target_record_ids[wave.target_position]
            then target_facts[wave.target_position]
            else closure_records -> pg_catalog.lower(wave.record_id::text) end as value
        ) as fact
        where fact.value is not null
      )
      -- Inherited ownership: the declared parent under the same permission,
      -- which repeats for the grandparent when that pair is expanded.
      select expanded.target_position, edge.relationship_id,
        edge.from_record_id, edge.to_record_id,
        edge.to_storage_contract_id as reached_contract, edge.to_record_id as reached_record,
        expanded.permission_id as reached_permission
      from expanded
      join vortex_record.relationship_edges as edge
        on edge.relationship_id = (expanded.meta ->> 'ownershipRelationshipId')::uuid
        and edge.from_storage_contract_id = (expanded.meta ->> 'storageContractId')::uuid
        and edge.from_record_id = expanded.record_id
      where expanded.meta is not null and expanded.scope is not null
        and expanded.meta ->> 'ownershipMode' = 'inherited'
        and expanded.meta ? 'ownershipRelationshipId'
        and exists (
          select 1 from pg_catalog.jsonb_array_elements(expanded.scope -> 'routes') as route(value)
          where route.value ->> 'kind' = 'ownership'
        )
      union all
      -- Relationship routes: the target is always the `to` endpoint, so the
      -- sources this permission can reach it through are the `from` rows of
      -- that relationship's edges, each expanded under its own source permission.
      select expanded.target_position, edge.relationship_id,
        edge.from_record_id, edge.to_record_id,
        edge.from_storage_contract_id, edge.from_record_id,
        (route.value ->> 'sourcePermissionId')::uuid
      from expanded
      cross join lateral pg_catalog.jsonb_array_elements(expanded.scope -> 'routes') as route(value)
      join vortex_record.relationship_edges as edge
        on edge.relationship_id = (route.value ->> 'relationshipId')::uuid
        and edge.to_storage_contract_id = (expanded.meta ->> 'storageContractId')::uuid
        and edge.to_record_id = expanded.record_id
      where expanded.meta is not null and expanded.scope is not null
        and route.value ->> 'kind' = 'relationship'
        and relationship_by_id ? pg_catalog.lower(route.value ->> 'relationshipId')
    loop
      if edge_item.reached_record <> target_record_ids[edge_item.target_position]
        and not closure_records ? pg_catalog.lower(edge_item.reached_record::text) then
        load_contracts := load_contracts || edge_item.reached_contract;
        load_records := load_records || edge_item.reached_record;
      end if;
      target_reached[edge_item.target_position] := target_reached[edge_item.target_position]
        || ',' || pg_catalog.lower(edge_item.reached_record::text);
      target_edges[edge_item.target_position] := target_edges[edge_item.target_position]
        || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'relationshipId', edge_item.relationship_id,
          'fromRecordId', edge_item.from_record_id,
          'toRecordId', edge_item.to_record_id
        ));
      next_targets := next_targets || edge_item.target_position;
      next_records := next_records || edge_item.reached_record;
      next_permissions := next_permissions || edge_item.reached_permission;
    end loop;

    -- Every pair of this wave is expanded now, including those that reached nothing.
    select seen_pairs || coalesce(pg_catalog.array_agg(distinct pg_catalog.format('%s:%s:%s',
        pair.target_position, pg_catalog.lower(pair.record_id::text),
        pg_catalog.lower(pair.permission_id::text))), array[]::text[])
    into seen_pairs
    from rows from (
      pg_catalog.unnest(wave_targets), pg_catalog.unnest(wave_records),
      pg_catalog.unnest(wave_permissions)
    ) as pair(target_position, record_id, permission_id);

    -- The related rows this wave reached, one query per storage contract.
    for current_contract in
      select distinct queued.contract_id
      from rows from (pg_catalog.unnest(load_contracts), pg_catalog.unnest(load_records))
        as queued(contract_id, record_id)
    loop
      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;
      load_sql := pg_catalog.format(
        'select coalesce(pg_catalog.jsonb_object_agg(
           pg_catalog.lower(stored.record_id::text), pg_catalog.jsonb_build_object(
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
           else ''{}''::jsonb end), ''{}''::jsonb)
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = any ($2)',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );
      execute load_sql into loaded_records using context_organization_id, array(
        select distinct queued.record_id
        from rows from (pg_catalog.unnest(load_contracts), pg_catalog.unnest(load_records))
          as queued(contract_id, record_id)
        where queued.contract_id = current_contract
      );
      closure_records := closure_records || loaded_records;
    end loop;
    load_contracts := array[]::uuid[];
    load_records := array[]::uuid[];

    wave_targets := next_targets;
    wave_records := next_records;
    wave_permissions := next_permissions;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions, built once for the call; per target the records
  -- its own closure reached and exactly the edges whose endpoints are both
  -- present, deduplicated.
  record_types_fact := coalesce((
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
  ), '[]'::jsonb);
  relationships_fact := coalesce((
    select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
    from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
  ), '[]'::jsonb);

  select coalesce(pg_catalog.jsonb_agg(outcome.value order by outcome.target_index), '[]'::jsonb)
  into results
  from (
    select indexed.target_index, case
      when target_results[indexed.target_index] is null
        then pg_catalog.jsonb_build_object('outcome', 'missing')
      when target_results[indexed.target_index] ->> 'outcome' = 'conflict'
        then target_results[indexed.target_index]
      else pg_catalog.jsonb_build_object(
        'outcome', 'loaded',
        'context', context_value,
        'declaration', typed.declaration,
        'facts', pg_catalog.jsonb_build_object(
          'binding', typed.declaration -> 'recordBinding',
          'recordTypes', record_types_fact,
          'relationships', relationships_fact,
          'sharingConditions', condition_list,
          'records', reached.records,
          'edges', present_edges.edges
        ),
        'accessPermissions', permission_by_id,
        'recordTypeMeta', typed.meta - 'isSystemProjection',
        'isSystemProjection', (typed.meta ->> 'isSystemProjection')::boolean,
        'table', typed.meta ->> 'table',
        'columns', typed.meta -> 'columns',
        'concurrencyNumber', target_results[indexed.target_index] -> 'concurrencyNumber',
        'definitionRevision', target_results[indexed.target_index] -> 'definitionRevision',
        'moduleReleaseRevision', (typed.meta ->> 'releaseRevision')::bigint,
        'fieldValues', target_facts[indexed.target_index] -> 'fieldValues'
      ) || case when p_installation ? 'previewInstallationId'
          and not (typed.meta ->> 'isSystemProjection')::boolean
        then pg_catalog.jsonb_build_object(
          'previewInstallationId', p_installation -> 'previewInstallationId'
        )
        else '{}'::jsonb end
    end as value
    from pg_catalog.generate_subscripts(target_record_ids, 1) as indexed(target_index)
    cross join lateral (
      select type_meta -> pg_catalog.lower(target_type_ids[indexed.target_index]::text) as meta,
        nullif(
          declarations -> pg_catalog.lower(target_type_ids[indexed.target_index]::text), 'null'::jsonb
        ) as declaration
    ) as typed
    cross join lateral (
      select coalesce(pg_catalog.jsonb_agg(present.fact order by present.record_key collate "C"), '[]'::jsonb)
          as records,
        coalesce(pg_catalog.array_agg(present.record_key), array[]::text[]) as record_keys
      from (
        select distinct record_key.value as record_key,
          case when record_key.value = pg_catalog.lower(target_record_ids[indexed.target_index]::text)
            then target_facts[indexed.target_index]
            else closure_records -> record_key.value end as fact
        from pg_catalog.unnest(pg_catalog.string_to_array(target_reached[indexed.target_index], ','))
          as record_key(value)
      ) as present
      where present.fact is not null
    ) as reached
    cross join lateral (
      select coalesce(pg_catalog.jsonb_agg(distinct edge.value), '[]'::jsonb) as edges
      from pg_catalog.jsonb_array_elements(target_edges[indexed.target_index]) as edge(value)
      where pg_catalog.lower(edge.value ->> 'fromRecordId') = any (reached.record_keys)
        and pg_catalog.lower(edge.value ->> 'toRecordId') = any (reached.record_keys)
    ) as present_edges
  ) as outcome;

  return results;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_with_plan_internal(text,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_with_plan_internal(
  text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_with_plan_internal(text,jsonb,jsonb,jsonb) to vortex_owner;

comment on function vortex_record.load_record_access_facts_with_plan_internal(text,jsonb,jsonb,jsonb) is
  'Private record access facts for a set of targets under one supplied installation and access plan: one result per target in the caller''s order; record types, declarations and the request context once per call, target rows in one query per record type, and the closure one edge query per wave.';
