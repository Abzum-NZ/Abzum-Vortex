create or replace function vortex_access.evaluate_record_permission_row_scope_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_auth_deadline timestamptz,
  p_application_root_id uuid,
  p_action jsonb,
  p_candidate jsonb,
  p_record_id uuid,
  p_facts jsonb,
  p_path uuid[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  context_account_id uuid := (p_context ->> 'organizationAccountId')::uuid;
  action_kind text := p_action ->> 'actionKind';
  candidate_permission jsonb := p_candidate -> 'permission';
  candidate_record_scope jsonb := p_candidate -> 'recordScope';
  candidate_valid_until timestamptz := (p_candidate ->> 'validUntil')::timestamptz;
  target_record jsonb;
  target_record_scope jsonb;
  target_type jsonb;
  has_all_records boolean;
  has_ownership boolean;
  has_direct_share boolean;
  route_list jsonb[] := array[]::jsonb[];
  deadline_list timestamptz[] := array[]::timestamptz[];
  ownership_admitted boolean;
  ownership_deadline timestamptz;
  chase_record jsonb;
  chase_scope jsonb;
  chase_type jsonb;
  chase_relationship jsonb;
  chase_edge jsonb;
  chase_edge_count integer;
  chase_target jsonb;
  parent_record jsonb;
  parent_scope jsonb;
  parent_type jsonb;
  visited_ids uuid[];
  chase_admitted boolean;
  chase_deadline timestamptz;
  share_row record;
  route jsonb;
  relationship_decl jsonb;
  source_owner_kind text;
  source_owner_id uuid;
  source_eval record;
  source_permission_entry vortex_access.permission_catalogue_entries;
  source_path_valid_until timestamptz;
  source_valid_until timestamptz;
  source_candidate jsonb;
  source_record jsonb;
  source_record_scope jsonb;
  edge_item jsonb;
  sub_result jsonb;
  sub_min_valid_until timestamptz;
  contribution_deadline timestamptz;
  condition_id uuid;
  saved_condition jsonb;
  projected_values jsonb;
  declared_field jsonb;
  reduced_type jsonb;
  condition_ok boolean;
  result jsonb;
begin
  select value into target_record
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
  limit 1;

  if target_record is null or target_record ->> 'lifecycleState' <> 'active' then
    return '[]'::jsonb;
  end if;

  target_record_scope := target_record -> 'recordScope';

  select value into target_type
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  where (value ->> 'recordTypeId')::uuid = (target_record_scope ->> 'recordTypeId')::uuid
  limit 1;

  if target_type is null then
    return '[]'::jsonb;
  end if;

  has_all_records := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'ownership'
  );
  has_direct_share := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'direct_share'
  );

  -- Step 2: base ownership/all-record routes, then inherited-ownership chase.
  if has_all_records or has_ownership then
    select outcome.admitted, outcome.valid_until into ownership_admitted, ownership_deadline
    from vortex_access.evaluate_current_record_ownership_visibility(
      candidate_record_scope,
      target_type ->> 'ownershipMode',
      context_organization_id,
      p_application_root_id,
      (target_type ->> 'moduleRootId')::uuid,
      (target_type ->> 'recordTypeId')::uuid,
      (target_type ->> 'storageContractId')::uuid,
      target_type ->> 'storageScope',
      target_record_scope,
      (target_record ->> 'ownerOrganizationAccountId')::uuid,
      (target_record ->> 'ownerGroupId')::uuid,
      context_organization_id,
      p_application_root_id,
      context_account_id,
      p_checked_at
    ) as outcome;

    if ownership_admitted then
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', case when has_all_records then 'all_records' else 'ownership' end
      ));
      deadline_list := pg_catalog.array_append(deadline_list, ownership_deadline);
    elsif has_ownership and target_type ->> 'ownershipMode' = 'inherited' then
      chase_record := target_record;
      chase_scope := target_record_scope;
      chase_type := target_type;
      visited_ids := array[(target_record_scope ->> 'recordId')::uuid];

      while chase_type ->> 'ownershipMode' = 'inherited' loop
        select value into chase_relationship
        from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_type ->> 'ownershipRelationshipId')::uuid
        limit 1;

        exit when chase_relationship is null;

        select pg_catalog.count(*) into chase_edge_count
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid;

        exit when chase_edge_count <> 1;

        select value into chase_edge
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid
        limit 1;

        select value into parent_record
        from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
        where (value -> 'recordScope' ->> 'recordId')::uuid = (chase_edge ->> 'toRecordId')::uuid
        limit 1;

        exit when parent_record is null or parent_record ->> 'lifecycleState' <> 'active';

        parent_scope := parent_record -> 'recordScope';

        select value into parent_type
        from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
        where (value ->> 'recordTypeId')::uuid = (parent_scope ->> 'recordTypeId')::uuid
        limit 1;

        exit when parent_type is null;

        select item.value into chase_target
        from pg_catalog.jsonb_array_elements(chase_relationship -> 'toRecordTypes') as item(value)
        where pg_catalog.lower(item.value ->> 'moduleRootId') =
            pg_catalog.lower(parent_scope ->> 'moduleRootId')
          and pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(parent_scope ->> 'recordTypeId')
        limit 1;

        exit when chase_target is null;

        exit when not vortex_access.record_relationship_witness_matches(
          (chase_relationship ->> 'relationshipId')::uuid,
          (chase_relationship ->> 'fromModuleRootId')::uuid,
          (chase_relationship ->> 'fromRecordTypeId')::uuid,
          (chase_target ->> 'moduleRootId')::uuid,
          (chase_target ->> 'recordTypeId')::uuid,
          (chase_edge ->> 'relationshipId')::uuid,
          (chase_edge ->> 'fromRecordId')::uuid,
          (chase_edge ->> 'toRecordId')::uuid,
          chase_scope,
          parent_scope,
          context_organization_id,
          p_application_root_id
        );

        exit when (parent_scope ->> 'recordId')::uuid = any(visited_ids);

        visited_ids := pg_catalog.array_append(visited_ids, (parent_scope ->> 'recordId')::uuid);
        chase_record := parent_record;
        chase_scope := parent_scope;
        chase_type := parent_type;
      end loop;

      if chase_type ->> 'ownershipMode' in ('organization_account', 'group') then
        select outcome.admitted, outcome.valid_until into chase_admitted, chase_deadline
        from vortex_access.evaluate_current_record_ownership_visibility(
          '{"routes":[{"kind":"ownership"}]}'::jsonb,
          chase_type ->> 'ownershipMode',
          context_organization_id,
          p_application_root_id,
          (chase_type ->> 'moduleRootId')::uuid,
          (chase_type ->> 'recordTypeId')::uuid,
          (chase_type ->> 'storageContractId')::uuid,
          chase_type ->> 'storageScope',
          chase_scope,
          (chase_record ->> 'ownerOrganizationAccountId')::uuid,
          (chase_record ->> 'ownerGroupId')::uuid,
          context_organization_id,
          p_application_root_id,
          context_account_id,
          p_checked_at
        ) as outcome;

        if chase_admitted then
          route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object('kind', 'ownership'));
          deadline_list := pg_catalog.array_append(deadline_list, chase_deadline);
        end if;
      end if;
    end if;
  end if;

  -- Step 3: direct share, read/update only, each recipient contributing
  -- independently with its own field bounds.
  if has_direct_share and action_kind in ('read', 'update') then
    for share_row in
      select *
      from vortex_access.read_current_direct_record_share_contributions(
        context_organization_id,
        p_application_root_id,
        (target_type ->> 'moduleRootId')::uuid,
        (target_type ->> 'recordTypeId')::uuid,
        (target_type ->> 'storageContractId')::uuid,
        target_type ->> 'storageScope',
        p_record_id,
        context_organization_id,
        p_application_root_id,
        context_account_id,
        p_checked_at
      )
    loop
      if action_kind = 'update' and pg_catalog.cardinality(share_row.changeable_field_ids) = 0 then
        continue;
      end if;
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', 'direct_share',
        'directShareId', share_row.direct_share_id,
        'directShareRevision', share_row.direct_share_revision,
        'readableFieldIds', pg_catalog.to_jsonb(share_row.readable_field_ids),
        'changeableFieldIds', pg_catalog.to_jsonb(share_row.changeable_field_ids)
      ));
      deadline_list := pg_catalog.array_append(deadline_list, share_row.valid_until);
    end loop;
  end if;

  -- Step 4: relationship routes. The target record is always the relationship's
  -- `to` endpoint and the source record its `from` endpoint (see
  -- runtime/definition/src/validation.ts). Every recursive step re-evaluates
  -- the source permission's own eligibility and own complete scope; authority
  -- never crosses alternatives.
  for route in
    select value from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where value ->> 'kind' = 'relationship'
  loop
    select value into relationship_decl
    from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
    where (value ->> 'relationshipId')::uuid = (route ->> 'relationshipId')::uuid
    limit 1;

    if relationship_decl is null
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_decl -> 'toRecordTypes') as declared(value)
        where pg_catalog.lower(declared.value ->> 'moduleRootId') = pg_catalog.lower(target_type ->> 'moduleRootId')
          and pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(target_type ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if (route ->> 'sourcePermissionId')::uuid = any(p_path) then
      continue;
    end if;

    begin
      select entry.owner_kind, entry.owner_id
      into strict source_owner_kind, source_owner_id
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registrations as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
      where entry.organization_id = context_organization_id
        and entry.application_root_id = p_application_root_id
        and entry.permission_id = (route ->> 'sourcePermissionId')::uuid
        and entry.record_type_id = (relationship_decl ->> 'fromRecordTypeId')::uuid
        and entry.action_kind = 'read'
        and entry.named_action is null;
    exception
      when no_data_found or too_many_rows then
        continue;
    end;

    source_eval := null;
    select evaluated.permission_entry, evaluated.path_valid_until
    into source_eval
    from vortex_access.evaluate_permission_role_path_internal(
      p_context,
      p_checked_at,
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      pg_catalog.jsonb_build_object('actionKind', 'read'),
      (relationship_decl ->> 'fromRecordTypeId')::uuid
    ) as evaluated
    limit 1;

    if source_eval is null or (source_eval.permission_entry).record_scope is null
      or source_eval.path_valid_until is null or p_auth_deadline is null then
      continue;
    end if;
    source_permission_entry := source_eval.permission_entry;
    source_path_valid_until := source_eval.path_valid_until;
    source_valid_until := least(source_path_valid_until, p_auth_deadline);

    source_candidate := pg_catalog.jsonb_build_object(
      'permission', pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      'recordScope', (source_permission_entry).record_scope,
      'source', pg_catalog.jsonb_build_object(
        'kind', (source_permission_entry).source_kind,
        'definitionKey', (source_permission_entry).source_definition_key,
        'rootId', (source_permission_entry).source_root_id,
        'releaseRevision', (source_permission_entry).source_revision,
        'releaseVersion', (source_permission_entry).source_version,
        'validationContractVersion', (source_permission_entry).source_validation_contract_version,
        'contentFingerprint', (source_permission_entry).source_content_fingerprint,
        'resolutionFingerprint', (source_permission_entry).source_resolution_fingerprint
      ),
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', source_valid_until), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );

    for edge_item in
      select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
      where (value ->> 'relationshipId')::uuid = (relationship_decl ->> 'relationshipId')::uuid
        and (value ->> 'toRecordId')::uuid = p_record_id
    loop
      select value into source_record
      from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
      where (value -> 'recordScope' ->> 'recordId')::uuid = (edge_item ->> 'fromRecordId')::uuid
      limit 1;

      if source_record is null or source_record ->> 'lifecycleState' <> 'active' then
        continue;
      end if;
      source_record_scope := source_record -> 'recordScope';

      if pg_catalog.lower(source_record_scope ->> 'recordTypeId')
        <> pg_catalog.lower(relationship_decl ->> 'fromRecordTypeId') then
        continue;
      end if;

      if not vortex_access.record_relationship_witness_matches(
        (relationship_decl ->> 'relationshipId')::uuid,
        (relationship_decl ->> 'fromModuleRootId')::uuid,
        (relationship_decl ->> 'fromRecordTypeId')::uuid,
        (target_type ->> 'moduleRootId')::uuid,
        (target_type ->> 'recordTypeId')::uuid,
        (edge_item ->> 'relationshipId')::uuid,
        (edge_item ->> 'fromRecordId')::uuid,
        (edge_item ->> 'toRecordId')::uuid,
        source_record_scope,
        target_record_scope,
        context_organization_id,
        p_application_root_id
      ) then
        continue;
      end if;

      sub_result := vortex_access.evaluate_record_permission_row_scope_internal(
        p_context,
        p_checked_at,
        p_auth_deadline,
        p_application_root_id,
        pg_catalog.jsonb_build_object('actionKind', 'read'),
        source_candidate,
        (edge_item ->> 'fromRecordId')::uuid,
        p_facts,
        pg_catalog.array_append(p_path, (route ->> 'sourcePermissionId')::uuid)
      );

      if pg_catalog.jsonb_array_length(sub_result) > 0 then
        select pg_catalog.min((elem.value ->> 'validUntil')::timestamptz) into sub_min_valid_until
        from pg_catalog.jsonb_array_elements(sub_result) as elem(value);

        contribution_deadline := least(source_valid_until, sub_min_valid_until);

        route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
          'kind', 'relationship',
          'relationshipId', (route ->> 'relationshipId')::uuid,
          'sourcePermissionId', (route ->> 'sourcePermissionId')::uuid,
          'sourceRecordId', (edge_item ->> 'fromRecordId')::uuid
        ));
        deadline_list := pg_catalog.array_append(deadline_list, contribution_deadline);
      end if;
    end loop;
  end loop;

  -- Step 5: a saved condition narrows every route, including all_records.
  if coalesce(pg_catalog.array_length(route_list, 1), 0) > 0
    and candidate_record_scope ? 'savedCondition' then
    condition_id := (candidate_record_scope -> 'savedCondition' ->> 'conditionId')::uuid;

    select value into saved_condition
    from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
    where (value ->> 'conditionId')::uuid = condition_id
    limit 1;

    if saved_condition is null then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    projected_values := '{}'::jsonb;
    for declared_field in
      select value from pg_catalog.jsonb_array_elements(saved_condition -> 'declaredFieldIds') as item(value)
    loop
      if not ((target_record -> 'fieldValues') ? (declared_field #>> '{}')) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      projected_values := projected_values || pg_catalog.jsonb_build_object(
        declared_field #>> '{}', (target_record -> 'fieldValues') -> (declared_field #>> '{}')
      );
    end loop;

    reduced_type := pg_catalog.jsonb_build_object(
      'recordTypeId', target_type -> 'recordTypeId',
      'fields', target_type -> 'fields'
    ) || case
      when target_type ? 'validationContractVersion' then
        pg_catalog.jsonb_build_object(
          'validationContractVersion', target_type -> 'validationContractVersion'
        )
      else '{}'::jsonb
    end;

    condition_ok := vortex_access.evaluate_permission_saved_condition(
      candidate_record_scope, saved_condition, reduced_type, projected_values, context_account_id
    );

    if condition_ok is not true then
      route_list := array[]::jsonb[];
      deadline_list := array[]::timestamptz[];
    end if;
  end if;

  -- Step 6: map to full matched contributions for this candidate.
  result := '[]'::jsonb;
  for route_index in 1 .. coalesce(pg_catalog.array_length(route_list, 1), 0) loop
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'permission', candidate_permission,
      'recordScope', candidate_record_scope,
      'source', p_candidate -> 'source',
      'route', route_list[route_index],
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', least(candidate_valid_until, deadline_list[route_index])),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ));
  end loop;

  return result;
end
$function$;

revoke execute on function vortex_access.evaluate_record_permission_row_scope_internal(
  jsonb, timestamptz, timestamptz, uuid, jsonb, jsonb, uuid, jsonb, uuid[]
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.evaluate_record_permission_row_scope_internal(
  jsonb, timestamptz, timestamptz, uuid, jsonb, jsonb, uuid, jsonb, uuid[]
) is
  'Private row-scope composition for one already-eligible permission against one exact record; returns matched contributions only, never a final allow/refuse result.';
