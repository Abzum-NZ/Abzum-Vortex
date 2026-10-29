create or replace function vortex_record.prepare_record_update_internal(
  p_command_id uuid,
  p_command_kind text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_action jsonb,
  p_meta jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := p_command_kind;
  action_owner_kind text := p_action ->> 'ownerKind';
  action_owner_id uuid := (p_action ->> 'ownerId')::uuid;
  action_release_revision bigint := (p_action ->> 'releaseRevision')::bigint;
  action_id_value uuid := (p_action ->> 'actionId')::uuid;
  preview_installation jsonb := vortex_record.read_current_preview_installation_internal();
  effective_command_id uuid := p_command_id;
  organization_id_value uuid := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  application_root_id_value uuid := (vortex_access.validated_human_request_context() ->> 'applicationRootId')::uuid;
  meta jsonb := p_meta;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := p_final_values;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  relationship_change jsonb;
  storage_change jsonb;
  prepared_relationship jsonb;
  prepared_relationships jsonb;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  activity_time timestamptz := pg_catalog.statement_timestamp();
  classification_value jsonb;
begin
  classification_value := vortex_record.classify_record_change_values_internal(
    p_record_type_id, final_values, meta, p_submitted_values,
    organization_id_value, application_root_id_value, receipt_kind, effective_command_id
  );
  if classification_value ->> 'outcome' <> 'classified' then
    return classification_value;
  end if;
  relationship_changes := classification_value -> 'relationshipChanges';
  value_final_values := classification_value -> 'valueFinalValues';
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(classification_value -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if action_mode then
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
  else
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (preview_installation is null
      and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is null then
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' = 'refused' then
      if action_mode then
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      else
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      end if;
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501',
        message = 'Record save authority is unavailable';
    end if;
    update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  else
    update_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if update_bounds is null then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  end if;
  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        update_bounds -> 'changeableFieldIds'
      ) as allowed(value)
      where pg_catalog.lower(allowed.value) =
        pg_catalog.lower(relationship_change ->> 'fieldId')
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Build the complete proposed source facts before the first mutation. A
  -- changed fixed relationship replaces its old edge; the exact validated
  -- target's private facts are loaded only inside this operation and are
  -- never returned. The same current update declaration must still allow the
  -- source under the complete proposed values and graph.
  proposed_field_values := (loaded -> 'fieldValues') || final_values;
  proposed_records := loaded -> 'facts' -> 'records';
  proposed_edges := loaded -> 'facts' -> 'edges';

  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
        or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
        or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
        or not pg_catalog.pg_input_is_valid(
          relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
        )
        or not pg_catalog.pg_input_is_valid(
          relationship_change -> 'value' ->> 'recordId', 'uuid'
        )
        or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (relationship_change -> 'value' ->> 'recordId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
      target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
      if not vortex_record.relationship_declares_target_internal(
        relationship_change -> 'relationship', target_record_type_id
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;

      target_loaded := vortex_record.load_record_access_facts_internal(
        target_record_type_id, 'read', target_record_id, null, null::jsonb
      );
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      -- Only a record of this application's own Module uses preview-owner authority.
      -- Borrowed records and live projections still need the builder's current permission.
      if preview_installation is not null
        and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
        and exists (
          select 1 from vortex_definition.roots as root
          where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
            and root.owner_application_root_id = application_root_id_value
        ) then
        target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
      else
        if pg_catalog.jsonb_array_length(
          target_loaded #> '{declaration,requiredPermissions}'
        ) = 0 then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
            '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
        );
      end if;
      if target_decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;

      proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
      proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
    end if;
  end loop;

  -- The one canonical lock prelude: every changed link's target row is
  -- share-locked in relationship identity order here, after each target has
  -- passed the same access decision the writer re-checks and before any
  -- source data version or relationship edge identity is taken. Keeping all
  -- target row locks in one place means no writer orders them on its own.
  perform vortex_record.lock_record_change_targets_internal(
    meta -> 'recordType', organization_id_value, final_values
  );

  -- Target closures may reach the source through a currently permitted
  -- relationship route. Assemble all trusted closures first, then make the
  -- source authoritative exactly once so an old source copy cannot compete
  -- with the proposed values. Other repeated closure records are collapsed by
  -- their permanent Record identity.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case when unique_record.record_id = p_record_id
        then unique_record.value || pg_catalog.jsonb_build_object(
          'fieldValues', proposed_field_values
        )
        else unique_record.value end
      order by unique_record.record_id
    )
    from (
      select distinct on (
        (record.value -> 'recordScope' ->> 'recordId')::uuid
      )
        (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
        record.value
      from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
      order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
        record.value::text collate "C"
    ) as unique_record
  ), '[]'::jsonb);

  -- Apply every changed fixed relationship after closure assembly. This one
  -- replacement pass removes old source edges even when a target closure
  -- contained them, then adds only the submitted non-null replacements.
  proposed_edges := coalesce((
    with retained_edges as (
      select edge.value
      from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where (changed.value ->> 'relationshipId')::uuid =
            (edge.value ->> 'relationshipId')::uuid
          and (edge.value ->> 'fromRecordId')::uuid = p_record_id
      )
    ), replacement_edges as (
      select pg_catalog.jsonb_build_object(
        'relationshipId', changed.value -> 'relationshipId',
        'fromRecordId', p_record_id,
        'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
      ) as value
      from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
      where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
    ), unique_edges as (
      select distinct candidate.value
      from (
        select retained.value from retained_edges as retained
        union all
        select replacement.value from replacement_edges as replacement
      ) as candidate(value)
    )
    select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
    from unique_edges as unique_edge
  ), '[]'::jsonb);

  proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'records', proposed_records,
    'edges', proposed_edges
  );
  if preview_installation is null then
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      if action_mode then
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      else
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      end if;
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
      );
    end if;
  end if;
  if final_values = '{}'::jsonb then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'empty_base_update'
    );
  end if;
  if action_mode then
    mutation := vortex_record.prepare_named_action_record_change_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number,
      value_final_values, value_submitted_field_ids,
      action_owner_kind, action_owner_id, action_release_revision, action_id_value
    );
  else
    mutation := vortex_record.prepare_record_change_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number,
      value_final_values, value_submitted_field_ids
    );
  end if;

  if mutation ->> 'outcome' = 'allowed' then
    storage_change := mutation -> 'storageChange';
    prepared_relationships := '[]'::jsonb;
    if preview_installation is null and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      perform vortex_record.bump_record_data_version_internal(
        organization_id_value, (meta ->> 'storageContractId')::uuid,
        case when meta ->> 'storageScope' = 'application_contained'
          then application_root_id_value else null end
      );
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      prepared_relationship := vortex_record.prepare_relationship_value_internal(
        p_record_type_id, p_record_id,
        (relationship_change ->> 'relationshipId')::uuid,
        relationship_change -> 'value', false
      );
      storage_change := pg_catalog.jsonb_set(storage_change, '{values}',
        (storage_change -> 'values') || pg_catalog.jsonb_build_object(
          prepared_relationship ->> 'column', prepared_relationship -> 'value'
        )
      );
      prepared_relationships := prepared_relationships ||
        pg_catalog.jsonb_build_array(prepared_relationship);
    end loop;
    mutation := mutation || pg_catalog.jsonb_build_object(
      'storageChange', storage_change, 'edgeChanges', prepared_relationships
    );
  end if;
  return mutation;
end
$function$;
alter function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb) is
  'Private common update preparation for ordinary and named-action records: locks the current revision and relationship targets, checks current and proposed authority and field bounds, and returns one combined scalar/link storage mutation and its edges.';
