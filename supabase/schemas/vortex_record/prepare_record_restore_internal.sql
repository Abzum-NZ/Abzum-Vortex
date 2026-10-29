create or replace function vortex_record.prepare_record_restore_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt_claim jsonb;
  plan_value jsonb;
  storage_set jsonb;
  preparation jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_restore', p_command_id, false
  );
  if receipt_claim ->> 'status' = 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'restored', 'recordId', receipt_claim -> 'result' -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'result' -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId', 'replayed', true,
      'unrestoredLinkCount', receipt_claim #> '{result,unrestoredLinkCount}'
    );
  elsif receipt_claim ->> 'status' is distinct from 'claimed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  plan_value := vortex_record.prepare_record_restore_closure_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if plan_value ->> 'outcome' is distinct from 'prepared' then return plan_value; end if;
  storage_set := vortex_record.prepare_record_storage_set_internal(plan_value -> 'storageChanges');
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', p_command_id::text, true);
  perform vortex_record.append_record_lifecycle_effect_internal((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'effectKind', case when (item.value ->> 'deleted')::boolean then 'restored' else 'links_restored' end,
      'storageContractId', item.value -> 'storageContractId',
      'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId',
      'preConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'relationshipId', null, 'previousValue', null,
      'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id, 'recordId', p_record_id
      ))
    )) from pg_catalog.jsonb_array_elements(plan_value -> 'subjects') as item(value)
  ));
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);
  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null, storage_set -> 'proposedRecords'
  );
  return preparation || pg_catalog.jsonb_build_object('unrestoredLinkCount', plan_value -> 'unrestoredLinkCount');
end
$function$;

alter function vortex_record.prepare_record_restore_internal(uuid,uuid,uuid,bigint) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_internal(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_internal(uuid,uuid,uuid,bigint) is
  'Private restore preparation: claims one command, journals its locked closure and prepares lifecycle rules and generated values against the proposed graph before any record write.';
