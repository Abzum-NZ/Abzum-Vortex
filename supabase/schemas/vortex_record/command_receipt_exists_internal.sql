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
    where receipt.command_id = p_command_id
      and receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.tenant_id = (context_value ->> 'tenantId')::uuid
      and receipt.command_kind = p_command_kind
  );
end
$function$;

alter function vortex_record.command_receipt_exists_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.command_receipt_exists_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.command_receipt_exists_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.command_receipt_exists_internal(
  text, uuid
) is
  'True when the request scope already holds a receipt for this command id and kind, whatever its state or content. Preparation reads use it to leave replay and identity-conflict classification to the receipt owner.';
