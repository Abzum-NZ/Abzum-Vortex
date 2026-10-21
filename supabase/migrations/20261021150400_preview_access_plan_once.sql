-- #3347: a preview read resolves the installation access plan once per call, and the linked titles of a page
-- for all target record types are read in one database call.

set local role vortex_record_adapter;

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
    -- Shape each protected reader row as the existing view's composite type.
    -- The view supplies the type only: its unbounded reader is never scanned.
    projection_reader_sql := case when p_projection_row is null then pg_catalog.format(
      'vortex_record.read_system_projection_rows_internal(%L::uuid, array[$2]::uuid[], %L, ''ascending'', null::jsonb, 1, null::jsonb) as projection',
      (target_meta ->> 'storageContractId')::uuid, target_projection_sort_key
    ) else
      'pg_catalog.jsonb_to_record($3) as projection(organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)'
    end;
    target_source_sql := pg_catalog.format($source$
      %s
      cross join lateral pg_catalog.jsonb_populate_record(
        null::record_data.%I,
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
      ) as stored$source$,
      projection_reader_sql, target_table, target_module_root_id, p_record_type_id,
      (target_meta ->> 'storageContractId')::uuid, target_release_revision,
      target_projection_definition #>> '{systemProjection,organizationFieldId}',
      target_projection_definition #>> '{systemProjection,revisionFieldId}',
      target_projection_definition
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

  -- A compatible reprovision can advance the shared projection view while an
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

create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb,
  p_projection_row jsonb,
  p_requested_field_ids jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  -- The access plan is resolved here, once for this call, and the one facts
  -- body consumes it. A caller that loads many records resolves the plan itself
  -- and calls load_record_access_facts_with_plan_internal directly.
  return vortex_record.load_record_access_facts_with_plan_internal(
    p_record_type_id, p_action_kind, p_record_id, p_expected_concurrency_number,
    p_installation, vortex_record.resolve_installation_access_plan_internal(p_installation),
    p_projection_row, p_requested_field_ids
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb,jsonb,jsonb) to vortex_owner;

create or replace function vortex_record.read_record_titles_internal(
  p_targets jsonb
)
returns table (record_type_id uuid, record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  target_item jsonb;
  target_type_id uuid;
  target_title_field_id uuid;
  target_record_ids uuid[];
  title_key text;
  context_value jsonb;
  installation jsonb;
  plan jsonb;
  preview_installation jsonb;
  preview_installation_id uuid;
  refused_installation boolean := false;
  requested_id uuid;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  chunk_start integer;
  decided_ids uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  readable_values jsonb;
  preview_meta jsonb;
begin
  if p_targets is null or pg_catalog.jsonb_typeof(p_targets) <> 'array' then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_targets) = 0 then
    return;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') <> 'array'
  ) or (
    select pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
  ) <> pg_catalog.jsonb_array_length(p_targets) then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;

  -- The verified request context and the current installation (the explicitly
  -- addressed preview for its owner, otherwise the active installation) are read
  -- once, and the installation access plan is resolved ONCE for the whole call:
  -- every record of every target type below decides against this one plan.
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  begin
    preview_installation := vortex_record.read_current_preview_installation_internal();
    if preview_installation is not null
      and preview_installation ->> 'outcome' = 'refused' then
      refused_installation := true;
    else
      installation := case when preview_installation is null
        then vortex_definition.read_current_active_installation()
        else preview_installation end;
      plan := vortex_record.resolve_installation_access_plan_internal(installation);
      if preview_installation is not null then
        preview_installation_id := (installation ->> 'previewInstallationId')::uuid;
      end if;
    end if;
  exception
    when no_data_found then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    when too_many_rows then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is ambiguous';
  end;

  for target_item in
    select item.value from pg_catalog.jsonb_array_elements(p_targets) as item(value)
  loop
    target_type_id := (target_item ->> 'recordTypeId')::uuid;
    target_title_field_id := (target_item ->> 'titleFieldId')::uuid;
    select coalesce(pg_catalog.array_agg(id.value::uuid order by id.ordinality), array[]::uuid[])
    into target_record_ids
    from pg_catalog.jsonb_array_elements_text(target_item -> 'recordIds')
      with ordinality as id(value, ordinality)
    where id.value is not null;
    title_key := pg_catalog.lower(target_title_field_id::text);
    first_loaded_id := null;
    first_loaded := null;
    page_declaration := null;
    page_eligibility := null;
    page_narrowed := null;
    candidate_ids := null;
    validated_record_types := null;
    decided_ids := array[]::uuid[];
    decided_loaded := array[]::jsonb[];
    decided_decisions := array[]::jsonb[];
    decided_bounds := array[]::jsonb[];
    -- Records the page read pass does not decide use the same installation and plan.
    page_shared := case when refused_installation then null
      else pg_catalog.jsonb_build_object('installation', installation, 'plan', plan) end;

    -- The eligibility is local to this invocation. It narrows work only when the
    -- per-record projection confirms the same declaration and a live deadline.
    if not refused_installation and target_type_id <> nil_uuid then
      foreach requested_id in array target_record_ids loop
        if requested_id = nil_uuid then
          continue;
        end if;
        loaded := vortex_record.load_record_access_facts_with_plan_internal(
          target_type_id, 'read', requested_id, null, installation, plan, null::jsonb
        );
        if loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
          page_declaration := loaded -> 'declaration';
          if loaded ? 'previewInstallationId' then
            preview_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
            page_shared := page_shared || pg_catalog.jsonb_build_object('previewBounds',
              vortex_record.preview_record_field_bounds_internal(
                target_type_id, (preview_meta ->> 'storageContractId')::uuid,
                preview_meta -> 'recordType'));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          first_loaded_id := requested_id;
          first_loaded := loaded;
          exit;
        end if;
      end loop;
    end if;

    -- The other ids are decided together by the page read pass (#2668), from
    -- the first record's exact facts, in sets of at most 200. The pass returns
    -- only the records it decided; every other id keeps the exact path below.
    if first_loaded is not null then
      select pg_catalog.array_agg(distinct candidate.id)
      into candidate_ids
      from pg_catalog.unnest(target_record_ids) as candidate(id)
      where candidate.id <> nil_uuid and candidate.id <> first_loaded_id;
    end if;
    if candidate_ids is not null then
      select page_shared
        || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
        page.narrowed
      into page_shared, page_narrowed
      from vortex_record.read_record_page_envelope_internal(target_type_id, first_loaded) as page;
      chunk_start := 1;
      while chunk_start <= coalesce(pg_catalog.cardinality(candidate_ids), 0) loop
        select decided_ids || coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          decided_loaded || coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
          decided_decisions || coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
          decided_bounds || coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          target_type_id, first_loaded, page_declaration, page_eligibility,
          candidate_ids[chunk_start:chunk_start + 199], page_shared -> 'envelope', page_narrowed
        ) as decided;
        chunk_start := chunk_start + 200;
      end loop;
    end if;

    foreach requested_id in array target_record_ids loop
      record_type_id := target_type_id;
      record_id := requested_id;
      if refused_installation then
        result := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        continue;
      end if;
      decided_index := case when requested_id is distinct from first_loaded_id
        then pg_catalog.array_position(decided_ids, requested_id) end;
      select row_projection.* into row_read
      from vortex_record.read_record_projection_with_validated_types_internal(
        target_type_id, requested_id, page_declaration, page_eligibility,
        validated_record_types, null::jsonb,
        coalesce(decided_loaded[decided_index],
          case when requested_id = first_loaded_id then first_loaded end),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_projection;
      if requested_id = first_loaded_id then
        first_loaded := null;
      end if;
      projection := row_read.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          row_read.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then row_read.read_facts #> '{facts,recordTypes}' end
        );
      end if;

      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        result := (projection - 'values') || pg_catalog.jsonb_build_object(
          'values', case when readable_values ? title_key
            then pg_catalog.jsonb_build_object(title_key, readable_values -> title_key)
            else '{}'::jsonb end
        );
      else
        result := projection;
      end if;
      return next;
    end loop;
  end loop;
  -- PL/pgSQL materializes this set before returning it. Revalidate after all
  -- projections so invocation-local preview facts cannot extend a builder's
  -- expiring role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview title authority is unavailable';
  end if;
end
$function$;

alter function vortex_record.read_record_titles_internal(jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_titles_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_titles_internal(jsonb) to vortex_owner;

comment on function vortex_record.read_record_titles_internal(jsonb) is
  'Private adapter batch of record titles for many target record types: the request context, current installation and access plan are resolved once for the whole call; per type the first record is decided exactly, the others together by the page read pass with a local page eligibility, and any record the pass does not decide (missing, inaccessible or relationship-routed) by the exact single-record path with the same refusal.';

create or replace function vortex_record.dimension_value_internal(
  p_values jsonb[],
  p_field jsonb
)
returns table (value jsonb, normalized jsonb, sort_rank integer, sort_title text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_type_id uuid;
  title_field_id uuid;
  target_context jsonb;
  readable_ids uuid[];
  readable_titles jsonb;
begin
  if coalesce(pg_catalog.cardinality(p_values), 0) = 0 then return; end if;
  if p_field ->> 'type' <> 'link' then
    -- Choice and date values keep their canonical text order.
    return query select item.value, item.value, 0, item.value::text from pg_catalog.unnest(p_values) as item(value);
    return;
  end if;
  target_type_id := (p_field #>> '{settings,target,recordTypeId}')::uuid;
  target_context := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  title_field_id := (target_context #>> '{recordType,titleFieldId}')::uuid;
  -- One protected batch for the distinct targets, before grouping or paging, shared by a pivot axis
  -- and a grid grouping. Missing, withheld
  -- and unreadable targets share one value: their identities never become separate axes.
  select coalesce(pg_catalog.array_agg(titles.record_id), array[]::uuid[]),
    coalesce(pg_catalog.jsonb_object_agg(
      titles.record_id::text, titles.result #>> array['values', title_field_id::text]
    ), '{}'::jsonb)
  into readable_ids, readable_titles
  from vortex_record.read_record_titles_internal(
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', target_type_id,
      'titleFieldId', title_field_id,
      'recordIds', coalesce((
        select pg_catalog.jsonb_agg(distinct (item.value ->> 'recordId')::uuid)
        from pg_catalog.unnest(p_values) as item(value)
        where item.value ->> 'recordTypeId' = target_type_id::text
      ), '[]'::jsonb)
    ))
  ) as titles
  where titles.result ->> 'outcome' = 'allowed'
    and titles.result -> 'values' ? title_field_id::text
    and nullif(titles.result #>> array['values', title_field_id::text], '') is not null;
  if target_context #>> '{recordType,systemProjection,protectedView}' = 'groups' then
    select coalesce(pg_catalog.array_agg(visible.record_id), array[]::uuid[])
    into readable_ids
    from vortex_access.list_visible_group_link_labels(readable_ids) as visible;
  end if;
  return query
    with readable as materialized (
      select distinct id from pg_catalog.unnest(readable_ids) as permitted(id)
    )
    -- Order: named targets by readable title, then Not set, then Not available last. The title's
    -- first 512 characters sort it, so the row key stays within the 4,096-character key contract;
    -- titles that share that prefix follow record identity. A target whose title is empty or
    -- withheld is not readable here, so it folds into Not available.
    select item.value, normalized.value,
      case when normalized.value = 'null'::jsonb then 1
        when normalized.value = '"not_available"'::jsonb then 2 else 0 end,
      coalesce(pg_catalog.left(readable_titles ->> (normalized.value ->> 'recordId'), 512), '')
    from pg_catalog.unnest(p_values) as item(value)
    left join readable on readable.id = (item.value ->> 'recordId')::uuid
    cross join lateral (select case
      when item.value is null or item.value = 'null'::jsonb then 'null'::jsonb
      when item.value ->> 'recordTypeId' = target_type_id::text
        and readable.id is not null then item.value
      else '"not_available"'::jsonb end as value) as normalized;
end
$function$;

alter function vortex_record.dimension_value_internal(jsonb[],jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.dimension_value_internal(jsonb[],jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.dimension_value_internal(jsonb[],jsonb) to vortex_owner;

comment on function vortex_record.dimension_value_internal(jsonb[],jsonb) is
  'Normalizes the distinct values of one pivot axis or grid grouping dimension through one protected target-title batch for a link and returns each value with its sort key (rank, readable title); all unreadable link targets fold into one Not available value before the summary groups and orders them.';

drop function vortex_record.read_record_titles_internal(uuid,uuid[],uuid);

set local role vortex_owner;

drop function vortex_record.read_record_titles(uuid,uuid[],uuid);

create or replace function vortex_record.read_record_projection_with_validated_types_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_page_declaration jsonb,
  p_page_eligibility jsonb,
  p_validated_record_types jsonb,
  p_projection_row jsonb,
  p_loaded jsonb,
  p_decision jsonb,
  p_bounds jsonb,
  p_page jsonb
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  -- The page-wide part of the facts (the envelope) when this record arrives
  -- as a compact record scope; otherwise the record's own complete facts.
  shared jsonb;
  compact boolean;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  field_values jsonb;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  preview_meta jsonb;
  preview_bounds jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
  batched boolean := false;
  requested_field_ids jsonb := nullif(p_page -> 'requestedFieldIds', 'null'::jsonb);
  projected_field_ids jsonb;
  stored_field_ids jsonb;
  selected_fields jsonb;
  selected_value_expression text;
  selected_values jsonb;
  selected_loaded jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  -- A page passes the page-wide part of the facts once (p_page.envelope) and
  -- each decided record as its compact record scope; the complete facts are
  -- rebuilt only on the paths that read more than this record's own values.
  compact := p_loaded is not null and p_loaded ? 'record'
    and pg_catalog.jsonb_typeof(p_page -> 'envelope') = 'object';
  if p_loaded is not null and p_loaded ? 'record' and not compact then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  loaded := case when compact then null else p_loaded end;
  if loaded is null and not compact then
    if p_page ? 'installation' then
      -- The installation this invocation read and validated once, with its
      -- access plan when the caller resolved it once for the whole page.
      loaded := case when p_page ? 'plan'
        then vortex_record.load_record_access_facts_with_plan_internal(
          p_record_type_id, 'read', p_record_id, null, p_page -> 'installation', p_page -> 'plan',
          p_projection_row, case when requested_field_ids is null then null else '[]'::jsonb end
        )
        else vortex_record.load_record_access_facts_from_installation_internal(
          p_record_type_id, 'read', p_record_id, null, p_page -> 'installation', p_projection_row,
          case when requested_field_ids is null then null else '[]'::jsonb end
        ) end;
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', p_record_id, null, p_projection_row,
        case when requested_field_ids is null then null else '[]'::jsonb end
      );
    end if;
  end if;
  shared := case when compact then p_page -> 'envelope' else loaded end;
  if p_loaded is not null and shared ->> 'outcome' = 'loaded' and (
    shared -> 'facts' -> 'binding' ->> 'recordTypeId' is distinct from
      pg_catalog.lower(p_record_type_id::text)
    or case when compact
      then p_loaded -> 'record' -> 'recordScope' ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text)
      else not exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where item.value -> 'recordScope' ->> 'recordId' = pg_catalog.lower(p_record_id::text)
      ) end
  ) then
    raise exception using errcode = '22023', message = 'Page record facts are invalid';
  end if;
  if shared ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(shared -> 'declaration') <> 'object' then
    projection := pg_catalog.jsonb_build_object('outcome', 'refused');
    return next;
    return;
  end if;
  if shared ? 'previewInstallationId' then
    if p_page -> 'envelope' -> 'previewInstallationId' = shared -> 'previewInstallationId'
      and pg_catalog.jsonb_typeof(p_page -> 'previewBounds') = 'object' then
      preview_bounds := p_page -> 'previewBounds';
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      preview_meta := vortex_record.resolve_record_action_context_internal(
        p_record_type_id, 'read'
      );
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
        preview_meta -> 'recordType'
      );
    end if;
    if preview_bounds is null then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      return next;
      return;
    end if;
    bounds := preview_bounds;
  else
    if p_decision is not null then
      -- The page's set pass decided this exact record in this invocation from
      -- these facts; only the fixed record adapter can pass it.
      if p_loaded is null
        or p_decision ->> 'recordId' is distinct from pg_catalog.lower(p_record_id::text) then
        raise exception using errcode = '22023', message = 'Page record decision is invalid';
      end if;
      -- It is used only while it is still current now: an allowed decision
      -- whose own deadline (every matched permission path, share and group
      -- membership) and the page eligibility are both still in the future.
      -- Anything else is decided again exactly, at this row's own time.
      batched := coalesce(p_decision ->> 'outcome' = 'allowed'
        and (p_decision ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp()
        and p_page_eligibility ->> 'outcome' = 'eligible'
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp(), false);
    end if;
    if batched then
      decision := p_decision;
    else
      loaded := coalesce(loaded, vortex_record.read_record_page_row_facts_internal(shared, p_loaded));
      if p_page_eligibility ->> 'outcome' = 'eligible'
        and loaded -> 'declaration' = p_page_declaration
        and (p_page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
        decision := vortex_access.evaluate_record_access_with_validated_types_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts', p_page_eligibility,
          p_validated_record_types
        );
      else
        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', p_record_id, loaded -> 'facts'
        );
      end if;
    end if;
    if decision ->> 'outcome' <> 'allowed' then
      projection := pg_catalog.jsonb_build_object('outcome', 'refused');
      -- A decision, even a refusal, means the record types passed validation;
      -- the page reuses them. Callers read read_facts only for allowed rows.
      read_facts := pg_catalog.jsonb_build_object(
        'validatedRecordTypes', shared -> 'facts' -> 'recordTypes'
      );
      return next;
      return;
    end if;
    bounds := coalesce(case when batched then p_bounds end,
      vortex_record.decide_record_field_bounds_internal(decision));
  end if;
  -- Keep full access bounds for capabilities; intersect only the values requested by the screen.
  projected_field_ids := bounds -> 'readableFieldIds';
  if requested_field_ids is not null then
    select coalesce(pg_catalog.jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into projected_field_ids
    from pg_catalog.jsonb_array_elements(projected_field_ids) with ordinality as item(value, ordinality)
    where requested_field_ids ? (item.value #>> '{}');
  end if;
  if requested_field_ids is not null and not compact then
    if (loaded ->> 'isSystemProjection')::boolean then
      -- Protected projections keep their bounded reader; never scan their composite view.
      selected_loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', p_record_id, null, p_projection_row, projected_field_ids
      );
      if selected_loaded ->> 'concurrencyNumber' is distinct from loaded ->> 'concurrencyNumber' then
        projection := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        return;
      end if;
      selected_values := selected_loaded -> 'fieldValues';
    else
      -- Decide access from condition operands first, then fetch only requested readable values.
      -- A concurrent record change cannot splice new values into the earlier access decision.
      select coalesce(pg_catalog.jsonb_agg(distinct item.value), '[]'::jsonb)
      into stored_field_ids
      from (
        select value from pg_catalog.jsonb_array_elements(projected_field_ids)
        union all
        select dependency.value
        from pg_catalog.jsonb_array_elements(loaded #> '{recordTypeMeta,fields}') as field(value)
        cross join lateral (values
          (field.value #> '{settings,expression,dueFieldId}'),
          (field.value #> '{settings,expression,statusFieldId}')
        ) as dependency(value)
        where projected_field_ids ? pg_catalog.lower(field.value ->> 'fieldId')
          and field.value ->> 'type' = 'calculation' and dependency.value is not null
      ) as item(value);
      select coalesce(pg_catalog.jsonb_agg(field.value), '[]'::jsonb) into selected_fields
      from pg_catalog.jsonb_array_elements(loaded #> '{recordTypeMeta,fields}') as field(value)
      where stored_field_ids ? pg_catalog.lower(field.value ->> 'fieldId');
      selected_value_expression := coalesce(vortex_record.named_action_storage_columns_internal(
        (loaded #>> '{recordTypeMeta,storageContractId}')::uuid, selected_fields
      ) ->> 'valueExpression', '');
      execute pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $3',
        selected_value_expression, loaded ->> 'table'
      ) into selected_values using (loaded #>> '{context,organizationId}')::uuid,
        p_record_id, (loaded ->> 'concurrencyNumber')::bigint;
      if selected_values is null then
        projection := pg_catalog.jsonb_build_object('outcome', 'refused');
        return next;
        return;
      end if;
    end if;
    loaded := pg_catalog.jsonb_set(loaded, '{fieldValues}', selected_values);
  end if;
  field_values := case when compact then p_loaded -> 'record' -> 'fieldValues'
    else loaded -> 'fieldValues' end;
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage. A page works out the record type's read-time
  -- fields and the statement's clock once and passes them here.
  if compact and p_page ? 'readTimeFields' then
    read_time_fields := p_page -> 'readTimeFields';
  else
    select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
    into read_time_fields
    from pg_catalog.jsonb_array_elements(shared -> 'facts' -> 'recordTypes') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      and field.value ->> 'type' = 'calculation'
      and (field.value #>> '{settings,evaluation}' = 'read_time'
        or field.value #>> '{settings,expression,kind}' = 'deadline_passed');
  end if;
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := case when compact and p_page ? 'readTimeClock' then p_page -> 'readTimeClock'
      else vortex_record.read_time_clock_internal() end;
  end if;
  if read_time_fields = '{}'::jsonb then
    -- Without read-time fields every readable stored value is projected as
    -- stored: one statement instead of one step per field.
    select coalesce(pg_catalog.jsonb_object_agg(item.value #>> '{}', field_values -> (item.value #>> '{}')
        order by item.ordinality), '{}'::jsonb)
    into values_value
    from pg_catalog.jsonb_array_elements(projected_field_ids) with ordinality as item(value, ordinality)
    where shared -> 'columns' ? (item.value #>> '{}');
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(projected_field_ids) as item(value)
    where read_time_fields <> '{}'::jsonb
  loop
    if not (shared -> 'columns' ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'kind' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression ->> 'dueFieldId');
      status_key := pg_catalog.lower(read_time_expression ->> 'statusFieldId');
      due_value := field_values -> due_key;
      status_value := case when status_key is null then null else field_values -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and shared -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, field_values -> field_id);
    end if;
  end loop;
  projection := pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', case when compact then p_loaded -> 'concurrencyNumber'
      else loaded -> 'concurrencyNumber' end,
    'values', values_value);
  -- A compact record keeps its compact scope; the caller holds the envelope.
  read_facts := case when compact then p_loaded else loaded end;
  read_bounds := bounds;
  return next;
end
$function$;

alter function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_validated_types_internal(uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  to vortex_record_adapter;

create or replace function vortex_record.read_record_titles(
  p_targets jsonb
)
returns table (record_type_id uuid, record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_count integer;
  record_count integer;
begin
  if p_targets is null or pg_catalog.jsonb_typeof(p_targets) <> 'array' then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  target_count := pg_catalog.jsonb_array_length(p_targets);
  if target_count > 20 then
    raise exception using errcode = '22023', message = 'Too many title target types';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') <> 'array'
      or item.value ->> 'recordTypeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or item.value ->> 'titleFieldId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'recordIds') as id(value)
    where pg_catalog.jsonb_typeof(id.value) <> 'string'
      or id.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(item.value -> 'recordIds')), 0)
  into record_count
  from pg_catalog.jsonb_array_elements(p_targets) as item(value);
  if record_count > 200 then
    raise exception using errcode = '22023', message = 'Too many title records';
  end if;
  return query select * from vortex_record.read_record_titles_internal(p_targets);
end
$function$;

alter function vortex_record.read_record_titles(jsonb) owner to vortex_owner;

revoke all on function vortex_record.read_record_titles(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record_titles(jsonb) to vortex_request;

comment on function vortex_record.read_record_titles(jsonb) is
  'Protected batch of record titles for many target record types ([{recordTypeId, titleFieldId, recordIds}], at most 20 types and 200 records); the restricted adapter applies the exact-record access decision to every requested id, resolving the installation access plan once for the call.';

reset role;
