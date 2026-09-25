create or replace function vortex_record.prepare_named_action_command_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_creations jsonb,
  p_activity_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  root_type jsonb;
  creation_count integer;
  before_closure jsonb;
  after_closure jsonb;
  link_targets jsonb;
  lock_plan jsonb;
  lock_entry jsonb;
  locked_value jsonb;
  target_loaded jsonb;
  target_decision jsonb;
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
  creation jsonb;
  access_loaded jsonb;
  access_decision jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object'
    or pg_catalog.jsonb_typeof(coalesce(p_creations, '[]'::jsonb)) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  creation_count := pg_catalog.jsonb_array_length(coalesce(p_creations, '[]'::jsonb));
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;
  -- Before-save Rule execution is #58's. The delivered set/announce path defers
  -- to the terminal writer's `contributes_to_total` probe; a create-bearing
  -- command refuses explicitly instead of being silently skipped.
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- Authorize the subject without a row lock before discovering or locking any
  -- concrete dependency, through the installed named declaration. Executing a
  -- permitted action still requires no ordinary read or update authority.
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
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
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);

  before_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  link_targets := vortex_record.named_action_command_link_targets_internal(
    catalogue, p_record_type_id, p_submitted_values, p_creations
  );
  if before_closure is null or link_targets is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- One canonical row pass over the union of closure records (`for update`) and
  -- concrete link targets (`for share`). Taking both here, in one ascending
  -- concrete identity order, is what keeps a later `for share` inside the edge
  -- writer from queueing behind an exclusive waiter while this command already
  -- holds a resource that waiter needs.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storageContractId', grouped.storage_contract_id,
      'recordId', grouped.record_id,
      'recordTypeId', grouped.record_type_id,
      'mode', case when grouped.exclusive then 'update' else 'share' end
    ) order by grouped.storage_contract_id, grouped.record_id
  ), '[]'::jsonb)
  into lock_plan
  from (
    select entry.storage_contract_id, entry.record_id, entry.record_type_id,
      pg_catalog.bool_or(entry.exclusive) as exclusive
    from (
      select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
        (item.value ->> 'recordId')::uuid as record_id,
        (item.value ->> 'recordTypeId')::uuid as record_type_id,
        true as exclusive
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      union all
      select (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid,
        (item.value ->> 'recordTypeId')::uuid,
        false
      from pg_catalog.jsonb_array_elements(link_targets) item(value)
    ) entry
    group by entry.storage_contract_id, entry.record_id, entry.record_type_id
  ) grouped;

  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(lock_plan) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if lock_entry ->> 'mode' = 'update' then
      locked_value := vortex_record.relationship_total_record_snapshot_internal(
        catalogue, (lock_entry ->> 'recordTypeId')::uuid,
        (lock_entry ->> 'recordId')::uuid, true
      );
      if locked_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'restart');
      end if;
    elsif not vortex_record.share_lock_named_action_target_internal(
      catalogue, (lock_entry ->> 'recordTypeId')::uuid, (lock_entry ->> 'recordId')::uuid
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  -- A creation's link target is an ordinary record and keeps the ordinary read
  -- requirement. Deciding it here, under the lock and before any write, turns
  -- an unreadable target into a clean refusal instead of a late rollback. The
  -- command's own subject is excluded: the named authority decided above is
  -- sufficient for it, and requiring ordinary read would contradict #50.
  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if (lock_entry ->> 'recordTypeId')::uuid = p_record_type_id
      and (lock_entry ->> 'recordId')::uuid = p_record_id then
      continue;
    end if;
    target_loaded := vortex_record.load_record_access_facts_internal(
      (lock_entry ->> 'recordTypeId')::uuid, 'read',
      (lock_entry ->> 'recordId')::uuid, null
    );
    if target_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_loaded -> 'declaration', (lock_entry ->> 'recordId')::uuid,
      target_loaded -> 'facts'
    );
    if target_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  after_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
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

  -- `not_required` is decided over the union of the subject type and every
  -- creation target type, and only after the locks above, so a command that
  -- needs no total still acquires its resources in the canonical order.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    join pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
      on true
    where field.value ->> 'type' = 'total'
  ) and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where pg_catalog.jsonb_array_length(
      coalesce(item.value -> 'recordType' -> 'relationships', '[]'::jsonb)
    ) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

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
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
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
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      source_records := '[]'::jsonb;
      if prepared_record ? 'recordId' then
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
          if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
            return pg_catalog.jsonb_build_object('outcome', 'restart');
          end if;
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
      end if;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then
          proposed_target := p_submitted_values -> source_field_id;
        end if;
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

      -- Each creation that links to this parent through this relationship joins
      -- its membership. A created record has no edges yet, so nothing is
      -- removed; the evaluator substitutes its computed values by record key.
      for creation in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
          with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') <>
          pg_catalog.lower((creation ->> 'recordTypeId')::uuid::text) then
          continue;
        end if;
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        proposed_target := creation -> 'values' -> source_field_id;
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and pg_catalog.lower(proposed_target ->> 'recordTypeId') =
            pg_catalog.lower(prepared_record ->> 'recordTypeId')
          and pg_catalog.lower(proposed_target ->> 'recordId') =
            pg_catalog.lower(prepared_record ->> 'recordId') then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordKey', 'create:' || (creation ->> 'ordinal'),
              'fieldValues', '{}'::jsonb
            )
          );
        end if;
      end loop;

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

revoke all on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';
