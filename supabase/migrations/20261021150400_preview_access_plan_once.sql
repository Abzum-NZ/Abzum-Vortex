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
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') is distinct from 'array'
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
  -- column for a board's first pages, each read in its own pass below.
  board_columns_mode boolean := false;
  board_columns jsonb := '[]'::jsonb;
  board_column_item jsonb;
  board_column_position integer := 0;
  board_column_pages jsonb := '[]'::jsonb;
  -- The stored choice column, when the reader is guaranteed to see the choice
  -- field on every scanned row, and the current column's candidate predicate.
  board_choice_column text;
  board_scan_sql text := '';
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
    board_scan_sql := case
      when board_choice_column is null then ''
      when board_column_kind = 'option' then pg_catalog.format(
        ' and stored.%I collate "C" = $13 collate "C"', board_choice_column)
      else pg_catalog.format(
        ' and (stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
        board_choice_column)
    end;
    if board_column_position > 1 then
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
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types);
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
          if board_member_mode then
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
      page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types);
    if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'hasChildren', (tree_item -> 'recordIds') ? (item.value ->> 'recordId')) order by item.ordinality)
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
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; returns with every plain page and board column read, even an empty one, the reader''s current field bound (the fields it is guaranteed to see on every record it may read, and whether any searchable field is among them) so a list offers and accepts its filter, search and sort controls from the same read; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, reads one column''s member page or, for a board''s first pages, the first page of every requested column in one invocation with its own budget and position per column, classifies those columns from current readable values and, when the choice field is guaranteed readable on every scanned row, narrows each column''s candidate scan to its own stored choice value so a column reads only its own cards, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values, and a grid dimension narrows the stored candidate scan only after the field is proven guaranteed readable, with date bucket membership using the same authored-zone canonical value as the summary and typed half-open calendar ranges; reads one level of a tree over a one-record link of the record type to itself, either the roots (records whose parent no access-readable record holds, so an unreadable parent is never revealed) or the children of one parent, through the same keyset order, access scan and exact per-row decision as a plain page, requiring the parent link to be a field the reader is guaranteed to see and reporting for every returned record, from one bounded set of rounds over the whole page rather than one query per row, whether the reader may read a child of it; orders board pages by record identity and generic members by the requested or query order with bidirectional keysets, returns generic group identity and the reader''s field bound even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; reads the copied records of a preview like installed ones and refuses a system projection in a preview; with a list of 1 to 200 distinct record ids it reads exactly those records in one page, each under the same scope, release, filter, search and readability decision as any row, and returns only those readable now.';

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
      -- The installation and access plan this invocation's caller read,
      -- validated and resolved once for the whole page.
      loaded := vortex_record.load_record_access_facts_with_plan_internal(
        p_record_type_id, 'read', p_record_id, null, p_page -> 'installation', p_page -> 'plan',
        p_projection_row, case when requested_field_ids is null then null else '[]'::jsonb end
      );
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
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') is distinct from 'array'
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
