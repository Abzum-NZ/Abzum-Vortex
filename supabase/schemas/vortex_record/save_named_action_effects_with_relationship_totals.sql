create or replace function vortex_record.save_named_action_effects_with_relationship_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb,
  p_declared_occurrence_ids jsonb,
  p_creations jsonb,
  p_creation_occurrence_ids jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_inputs jsonb
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
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer;
  preparation_value jsonb;
  result_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  relationship_value jsonb;
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
  inserted_value jsonb;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  changed_field_ids uuid[];
  occurrence_id_value uuid;
  event_result jsonb;
  copy_plan jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array'
    or pg_catalog.jsonb_typeof(p_creations) <> 'array'
    or pg_catalog.jsonb_typeof(p_creation_occurrence_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_creations) <>
      pg_catalog.jsonb_array_length(p_creation_occurrence_ids) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  creation_count := pg_catalog.jsonb_array_length(p_creations);
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;

  if not vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    creation_plan := vortex_record.named_action_creation_plan_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_creations
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
      p_submitted_values, p_creations, p_activity_id, p_action_owner_kind,
      p_action_owner_id, p_action_release_revision, p_action_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' = 'defer' and vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
      preparation_value := null;
    elsif preparation_value ->> 'outcome' = 'defer' then
      -- Preserved unchanged from `save_base_record_with_relationship_totals`
      -- (`20260914013000:817-904`): with an installed Rule the closure is not
      -- computed, so a command that would move a total must refuse rather than
      -- silently skip it. A create-bearing command already refused inside the
      -- preparation, so only the delivered set/announce shape reaches here.
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
              if p_final_values ? dependency_field_id and
                p_final_values -> dependency_field_id is distinct from
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

  -- #570: copy_relationships. The target row and every linked row are locked
  -- here, before the counters and data versions below and before any edge
  -- identity, so the lock classes keep their order. A replay copies nothing.
  if not vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id, p_inputs
    );
    if copy_plan ->> 'outcome' = 'refused' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
      );
    end if;
  end if;
  -- #569: take every created record's reference-number counter (L4), then the
  -- data version of the subject's and every created record's storage scope,
  -- before the subject writer writes the subject's relationship edges (L6),
  -- matching ordinary create's row, counter, data version, edge order.
  if creation_count > 0 and create_targets is not null then
    perform vortex_record.reserve_named_action_creation_locks_internal(
      p_record_type_id, p_creations
    );
  end if;
  result_value := vortex_record.save_named_action_set_announce(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_submitted_values, p_final_values, p_activity_id, p_occurrence_id,
    p_declared_occurrence_ids, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_inputs
  );
  -- The subject writer reports 'saved' when it wrote the subject and
  -- 'completed' when the action had nothing to write to it. Both are a claimed
  -- receipt and a committed subject step; only a replay short-circuits here.
  if result_value ->> 'outcome' not in ('saved', 'completed')
    or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Step 4: every insert, in authored effect order, before any edge. Each
    -- allocates its reference numbers (L4); keeping the whole set ahead of the
    -- edge pass is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
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

    -- Step 5: every edge, in one canonical order across all creations: by
    -- relationship, then target, matching the ascending relationship edge
    -- identity order every ordinary writer loop uses.
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
      from pg_catalog.jsonb_array_elements(p_creations) creation_item(value)
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
        p_action_owner_kind, p_action_owner_id, p_action_release_revision,
        p_action_id, p_record_type_id, p_record_id
      );
    end loop;

    -- Step 6: the exact create decision only exists now, with the derived owner
    -- and the complete new graph in place. A denial raises, rolling the whole
    -- command back with no post-rollback refusal Activity (#50 section 8).
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      perform vortex_record.authorize_named_action_created_record_internal(
        (creation ->> 'recordTypeId')::uuid, created_record_id, submitted_field_ids
      );
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(p_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(p_creations) with ordinality position(value, ordinality)
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
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023',
        message = 'Relationship total parent mutation is incomplete';
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
  return result_value || pg_catalog.jsonb_build_object('createdRecords', created_records);
end
$function$;

revoke all on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb
) to vortex_runtime;
comment on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb
) is
  'Protected named action composed with created records, their edges, authority, Activity and Events, and revision-checked parent totals, in one transaction.';
