create or replace function vortex_record.prepare_record_update_internal(
  p_command_id uuid,
  p_command_kind text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_activity_id uuid,
  p_action jsonb,
  p_meta jsonb,
  p_proposal jsonb,
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
  loaded jsonb := p_proposal -> 'loaded';
  proposed_facts jsonb := p_proposal -> 'proposedFacts';
  relationship_changes jsonb := p_proposal -> 'classification' -> 'relationshipChanges';
  value_final_values jsonb := p_proposal -> 'classification' -> 'valueFinalValues';
  final_values jsonb := p_final_values;
  decision jsonb;
  mutation jsonb;
  relationship_change jsonb;
  storage_change jsonb;
  prepared_relationship jsonb;
  prepared_relationships jsonb;
  value_submitted_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
begin
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(p_proposal -> 'classification' -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if preview_installation is null then
    decision := vortex_record.decide_record_access_internal(p_memo, loaded -> 'declaration', p_record_id, proposed_facts);
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
      value_final_values, value_submitted_field_ids, loaded, p_memo
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
alter function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb) is
  'Private second stage of common update preparation for ordinary and named-action records: checks the proposed-state authority the set decided for the proposal, and returns one combined scalar/link storage mutation and its edges.';
