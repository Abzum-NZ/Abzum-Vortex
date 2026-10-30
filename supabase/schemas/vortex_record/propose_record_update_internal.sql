create or replace function vortex_record.propose_record_update_internal(
  p_command_id uuid,
  p_command_kind text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_activity_id uuid,
  p_action jsonb,
  p_meta jsonb,
  p_classification jsonb,
  p_loaded jsonb,
  p_targets jsonb,
  p_memo jsonb
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
  relationship_changes jsonb := p_classification -> 'relationshipChanges';
  final_values jsonb := p_final_values;
  relationship_change jsonb;
  update_bounds jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  activity_time timestamptz := pg_catalog.statement_timestamp();
begin
  if action_mode then
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
  else
    loaded := coalesce(p_loaded, (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', p_record_type_id, 'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number))) -> 0));
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
    decision := vortex_record.decide_record_access_internal(
      p_memo, meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', meta -> 'declaration' -> 'recordBinding' )
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
    update_bounds := vortex_record.remembered_record_field_bounds_internal(p_memo, decision, 'resolved');
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
  proposed_records := loaded -> 'facts' -> 'records';
  proposed_edges := loaded -> 'facts' -> 'edges';

  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
      target := vortex_record.relationship_change_target_internal(relationship_change);
      if target is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      target_record_type_id := (target ->> 'recordTypeId')::uuid;
      target_record_id := (target ->> 'recordId')::uuid;

      -- The set loaded every exact target once, before any record was prepared.
      target_loaded := p_targets -> (pg_catalog.lower(target_record_type_id::text) || ':' || pg_catalog.lower(target_record_id::text));
      if target_loaded is null then
        raise exception using errcode = '55000', message = 'Relationship target facts were not loaded';
      end if;
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
        target_decision := vortex_record.decide_record_access_internal(
          p_memo, pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb),
          target_record_id, target_loaded -> 'facts'
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

  proposed_facts := vortex_record.proposed_update_facts_internal(
    loaded, p_record_id, final_values, relationship_changes, proposed_records, proposed_edges
  );
  -- The proposal is everything the proposed-state decision and the write need; the set decides
  -- every proposal together before any is written.
  return pg_catalog.jsonb_build_object(
    'outcome', 'proposed', 'loaded', loaded, 'classification', p_classification,
    'proposedFacts', proposed_facts,
    'changeFacts', case when action_mode then null else
      vortex_record.proposed_change_facts_internal(
        loaded, p_record_id, p_classification -> 'valueFinalValues') -> 'facts' end
  );
end
$function$;
alter function vortex_record.propose_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.propose_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.propose_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) is
  'Private first stage of common update preparation for ordinary and named-action records: loads the current revision, checks current authority and field bounds, loads and checks relationship targets from the set-wide target facts, takes the relationship target row locks, and returns the complete proposed source facts for the proposed-state decision.';
