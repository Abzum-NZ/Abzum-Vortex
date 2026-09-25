create or replace function vortex_record.transfer_record_ownership(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  projection jsonb;
  event_result jsonb;
  updated_concurrency_number bigint;
  changed_rows integer;
begin
  if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_target_id is null or p_target_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  command_fingerprint_value := vortex_record.ownership_transfer_command_fingerprint_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_target_kind, p_target_id, 'public', null
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, 'transfer_ownership', command_fingerprint_value,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- A replay reprojects from current access and intentionally never returns
    -- owner metadata (including the prior target).
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId', 'replayed', true
    );
  end if;
  -- The closed transfer authority is its own exact record permission decision;
  -- it is evaluated under the record lock, while owner columns remain
  -- unavailable to the ordinary update writer.
  -- Public transfer is active-installation-only.  It deliberately never calls
  -- the retained/detached reader, so a detached record cannot leak its current
  -- revision through the ordinary conflict response.
  begin
    installation := vortex_module.read_current_active_installation();
  exception
    when no_data_found then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
  end;
  loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number, installation
  );
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into record_type_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if record_fact is null or record_type_fact is null
    or record_fact ->> 'lifecycleState' <> 'active' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  ownership_mode := record_type_fact ->> 'ownershipMode';
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_ownership_transfer_activity_internal(
      p_activity_id, organization_id_value, 'refused'
    );
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  elsif decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
  end if;
  if ownership_mode = 'organization_account' then
    previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
  elsif ownership_mode = 'group' then
    previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
  else
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if (ownership_mode = 'organization_account' and p_target_kind <> 'organization_account')
    or (ownership_mode = 'group' and p_target_kind <> 'group')
    or previous_owner_id is null or previous_owner_id = p_target_id
    or not vortex_access.lock_active_record_ownership_target_internal(p_target_kind, p_target_id) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'owner_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id = $3,
       owner_group_id = $4, concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $6 returning stored.concurrency_number',
    loaded ->> 'table'
  ) into updated_concurrency_number using organization_id_value, p_record_id,
    case when p_target_kind = 'organization_account' then p_target_id else null end,
    case when p_target_kind = 'group' then p_target_id else null end,
    actor_id_value, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
  end if;
  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (record_type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  update vortex_record.record_deadline_due_metadata as metadata
  set record_concurrency_number = updated_concurrency_number,
    changed_at = pg_catalog.statement_timestamp()
  where metadata.organization_id = organization_id_value
    and metadata.storage_contract_id = (record_type_fact ->> 'storageContractId')::uuid
    and metadata.record_id = p_record_id
    and metadata.application_root_id is not distinct from case
      when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
        then application_root_id_value else null end;
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
  event_result := vortex_event.append_record_occurrences(
    (record_type_fact ->> 'storageContractId')::uuid,
    p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
      ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
  end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id, updated_concurrency_number,
    'Record ownership transfer receipt is stale'
  );
  -- This is deliberately an undisclosed result: an authorised transfer may
  -- remove the operator's read path.  A post-write projection would turn that
  -- valid committed mutation into a rollback.  Exact replay still applies
  -- current disclosure separately above.
  return pg_catalog.jsonb_build_object(
    'outcome', 'transferred', 'recordId', p_record_id,
    'concurrencyNumber', updated_concurrency_number,
    'correlationId', context_value -> 'correlationId', 'replayed', false
  );
end
$function$;

revoke all on function vortex_record.transfer_record_ownership(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.transfer_record_ownership(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.transfer_record_ownership(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid
) is
  'Fixed server-only single-record ownership transfer: current explicit transfer authority, compatible active target and expected revision, atomically with Activity, reassigned Event/queue and receipt.';
