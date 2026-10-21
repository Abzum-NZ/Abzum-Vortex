CREATE OR REPLACE FUNCTION vortex_record.load_named_action_facts_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  p_action_kind text := 'named';
  action_context jsonb;
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  installation jsonb;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  module_root_value uuid;
  type_meta jsonb := '{}'::jsonb;
  module_type_meta jsonb;
  storage_disagrees boolean;
  type_columns jsonb;
  target_columns jsonb;
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
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
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

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; this adapter consumes them and adds none.
  installation := vortex_definition.read_current_active_installation();

  -- Step 3: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Each release is read in a
  -- few set-based statements instead of a PL/pgSQL round trip for every type,
  -- field and permission. Physical tokens are resolved here; a type's column
  -- map and value expression are built only when one of its rows is loaded.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;
    release_content := vortex_record.with_installed_record_contributions_internal(
      release_content, context_organization_id, module_root_value
    );

    -- Every record type must agree with its storage: an active catalogue entry
    -- for this Module and type, provisioned by this release, with an active
    -- column for each declared field.
    select coalesce(pg_catalog.bool_or(
        catalogue.storage_contract_id is null
        or catalogue.state <> 'active'
        or catalogue.module_root_id <> module_root_value
        or catalogue.record_type_id <> (record_type_item.value ->> 'recordTypeId')::uuid
        or catalogue.storage_scope is distinct from (record_type_item.value ->> 'storageScope')
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and catalogue.storage_contract_id = any (provision.storage_contract_ids)
        )
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(record_type_item.value -> 'fields') as field_item(value)
          left join vortex_record.field_storage_mappings as mapping
            on mapping.storage_contract_id = catalogue.storage_contract_id
            and mapping.field_id = (field_item.value ->> 'fieldId')::uuid
          where mapping.storage_contract_id is null or mapping.state <> 'active'
        )
      ), false),
      pg_catalog.jsonb_object_agg(
        pg_catalog.lower(record_type_item.value ->> 'recordTypeId'),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', (record_type_item.value ->> 'recordTypeId')::uuid,
          'storageContractId', (record_type_item.value ->> 'storageContractId')::uuid,
          'storageScope', record_type_item.value ->> 'storageScope',
          'physicalSchemaToken', catalogue.physical_schema_token,
          'ownershipMode', record_type_item.value ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue.physical_table_token,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item.value -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by record_type_item.ordinality
      )
    into storage_disagrees, module_type_meta
    from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes')
      with ordinality as record_type_item(value, ordinality)
    left join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = (record_type_item.value ->> 'storageContractId')::uuid;
    if storage_disagrees then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    type_meta := type_meta || coalesce(module_type_meta, '{}'::jsonb);

    -- Every declared target, single or polymorphic, as one uniform list;
    -- Access proves a concrete edge target a member of it.
    relationship_by_id := relationship_by_id || coalesce((
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(relationship_item.value ->> 'relationshipId'),
        pg_catalog.jsonb_build_object(
          'relationshipId', relationship_item.value -> 'relationshipId',
          'fromModuleRootId', module_root_value,
          'fromRecordTypeId', record_type_item.value -> 'recordTypeId',
          'toRecordTypes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'moduleRootId', target.value -> 'moduleRootId',
              'recordTypeId', target.value -> 'recordTypeId'
            ) order by target.ordinality)
            from pg_catalog.jsonb_array_elements(
              case when relationship_item.value ? 'toRecordType'
                then pg_catalog.jsonb_build_array(relationship_item.value -> 'toRecordType')
                else relationship_item.value -> 'toRecordTypes'
              end
            ) with ordinality as target(value, ordinality)
          ), '[]'::jsonb)
        )
        order by record_type_item.ordinality, relationship_item.ordinality
      )
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes')
        with ordinality as record_type_item(value, ordinality)
      cross join lateral pg_catalog.jsonb_array_elements(record_type_item.value -> 'relationships')
        with ordinality as relationship_item(value, ordinality)
    ), '{}'::jsonb);

    condition_list := condition_list || coalesce((
      select pg_catalog.jsonb_agg(condition_item.value order by condition_item.ordinality)
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) with ordinality as condition_item(value, ordinality)
    ), '[]'::jsonb);

    permission_by_id := permission_by_id || coalesce((
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(permission_item.value ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'module',
          'ownerId', module_root_value,
          'recordTypeId', permission_item.value -> 'recordTypeId',
          'actionKind', permission_item.value -> 'actionKind',
          'namedAction', permission_item.value -> 'namedAction',
          'recordScope', permission_item.value -> 'recordScope'
        )
        order by permission_item.ordinality
      )
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) with ordinality as permission_item(value, ordinality)
      where pg_catalog.jsonb_typeof(permission_item.value -> 'recordScope') = 'object'
    ), '{}'::jsonb);
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = context_application_root_id
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;

  permission_by_id := permission_by_id || coalesce((
    select pg_catalog.jsonb_object_agg(
      pg_catalog.lower(permission_item.value ->> 'permissionId'),
      pg_catalog.jsonb_build_object(
        'ownerKind', 'application',
        'ownerId', context_application_root_id,
        'recordTypeId', permission_item.value -> 'recordTypeId',
        'actionKind', permission_item.value -> 'actionKind',
        'namedAction', permission_item.value -> 'namedAction',
        'recordScope', permission_item.value -> 'recordScope'
      )
      order by permission_item.ordinality
    )
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) with ordinality as permission_item(value, ordinality)
    where pg_catalog.jsonb_typeof(permission_item.value -> 'recordScope') = 'object'
  ), '{}'::jsonb);

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  if target_meta ->> 'physicalSchemaToken' is distinct from 'record_data' then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;
  target_columns := vortex_record.named_action_storage_columns_internal(
    (target_meta ->> 'storageContractId')::uuid, target_meta -> 'fields'
  );
  type_columns := pg_catalog.jsonb_build_object(
    target_meta ->> 'storageContractId', target_columns
  );
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the exact named declaration resolved from the installed owner.
  required_permissions := action_context #> '{declaration,requiredPermissions}';
  declaration := action_context -> 'declaration';

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
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
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_columns ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
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
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;
      if current_meta ->> 'physicalSchemaToken' is distinct from 'record_data' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if not (type_columns ? (current_meta ->> 'storageContractId')) then
        type_columns := type_columns || pg_catalog.jsonb_build_object(
          current_meta ->> 'storageContractId',
          vortex_record.named_action_storage_columns_internal(
            (current_meta ->> 'storageContractId')::uuid, current_meta -> 'fields'
          )
        );
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
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope',
        type_columns #>> array[current_meta ->> 'storageContractId', 'valueExpression'],
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
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
    'table', target_table,
    'columns', target_columns -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'actionContext', action_context,
    'fieldValues', target_fact -> 'fieldValues'
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

alter function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) to vortex_record_adapter;

comment on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) is
  'Private static named-action facts loader reusing the complete existing Access record-scope closure without requiring ordinary read or update authority.';
