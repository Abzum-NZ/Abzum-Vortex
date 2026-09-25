create or replace function vortex_record.lock_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid
)
returns vortex_record.command_receipts
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
  for update;
  return receipt;
end
$function$;

revoke all on function vortex_record.lock_command_receipt_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.lock_command_receipt_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.lock_command_receipt_internal(
  text, uuid
) is
  'Locks and returns the request actor''s command receipt, or a row of nulls when there is none. Finalizing writers read the state the preflight stored through it.';
