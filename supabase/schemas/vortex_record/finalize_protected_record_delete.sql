create or replace function vortex_record.finalize_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record delete is not prepared';
  end if;

  -- Closure identity and revisions are re-derived under the held locks rather
  -- than taken from the caller.
  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '40001',
      message = 'Protected record delete closure changed';
  end if;
  perform vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, false, p_parent_mutations
  );

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind = 'soft_deleted' then
      event_kind := 'deleted';
    else
      event_kind := 'unlinked';
    end if;
    event_result := vortex_event.append_record_occurrences(
      effect_row.storage_contract_id, effect_row.record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', case
          when event_kind = 'deleted' and effect_row.record_id = p_record_id
            and effect_row.record_type_id = p_record_type_id
            then receipt.occurrence_id
          else pg_catalog.gen_random_uuid() end,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', effect_row.record_type_id
        ),
        'payload', pg_catalog.jsonb_build_object('kind', event_kind)
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) <> 1 then
      raise exception using errcode = '55000',
        message = 'Protected record delete Event append failed';
    end if;
  end loop;

  select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
    into subject_ids
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  if subject_ids is null or not (p_record_id = any (subject_ids)) then
    raise exception using errcode = '55000',
      message = 'Protected record delete effects are unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'delete', subject_ids
  );

  update vortex_record.record_lifecycle_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = p_expected_concurrency_number + 1,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = receipt.organization_id
    and stored.application_root_id = receipt.application_root_id
    and stored.actor_organization_account_id = receipt.actor_organization_account_id
    and stored.command_id = receipt.command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected record delete receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'deleted',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
)
  to vortex_runtime;
comment on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
) is
  'Protected delete writer: generated parent values, standard Events, Activity and receipt in the preflight transaction.';
