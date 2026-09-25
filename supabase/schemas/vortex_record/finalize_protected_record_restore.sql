create or replace function vortex_record.finalize_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb
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
  revisions jsonb;
  restored_revision bigint;
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
    or receipt.operation is distinct from 'restore'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record restore is not prepared';
  end if;

  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared'
    or (
      select (item.value ->> 'concurrencyNumber')::bigint
      from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
      where item.value ->> 'recordKey' = 'root'
    ) is distinct from p_expected_concurrency_number + 1 then
    raise exception using errcode = '40001',
      message = 'Protected record restore closure changed';
  end if;
  revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, true, p_mutations
  );
  select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
  from pg_catalog.jsonb_array_elements(revisions) as item(value)
  where item.value ->> 'recordKey' = 'root';

  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'restore', array[p_record_id]::uuid[]
  );

  update vortex_record.record_lifecycle_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = restored_revision,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = receipt.organization_id
    and stored.application_root_id = receipt.application_root_id
    and stored.actor_organization_account_id = receipt.actor_organization_account_id
    and stored.command_id = receipt.command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected record restore receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'restored',
    'recordId', p_record_id,
    'concurrencyNumber', restored_revision,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
)
  to vortex_runtime;
comment on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
) is
  'Protected restore writer: refreshed generated values of the record and its parents, Activity and receipt in the preflight transaction.';
