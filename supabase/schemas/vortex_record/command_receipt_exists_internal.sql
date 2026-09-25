create or replace function vortex_record.command_receipt_exists_internal(
  p_command_kind text,
  p_command_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_kind = p_command_kind
      and receipt.command_id = p_command_id
  );
end
$function$;

revoke all on function vortex_record.command_receipt_exists_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.command_receipt_exists_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.command_receipt_exists_internal(
  text, uuid
) is
  'True when the request actor already holds a receipt for this command identity and kind, whatever its state or content. Preparation reads use it to leave replay and identity-conflict classification to the receipt owner.';
