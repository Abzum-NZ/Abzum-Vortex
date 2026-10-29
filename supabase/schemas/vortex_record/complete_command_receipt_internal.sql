create or replace function vortex_record.complete_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_result jsonb,
  p_stale_message text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  if p_result is null then
    raise exception using errcode = '22023', message = 'Command result must not be null';
  end if;
  context_value := vortex_access.validated_human_request_context();
  update vortex_record.command_receipts as stored
  set result = p_result
  where stored.command_id = p_command_id
    and stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.tenant_id = (context_value ->> 'tenantId')::uuid
    and stored.actor_id = (context_value ->> 'organizationAccountId')::uuid
    and stored.command_kind = p_command_kind
    and stored.result is null;
  if not found then
    raise exception using errcode = '40001', message = p_stale_message;
  end if;
end
$function$;

alter function vortex_record.complete_command_receipt_internal(text,uuid,jsonb,text) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) to vortex_record_adapter;
comment on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) is
  'Completes the request scope''s pending command receipt with its result, or raises a 40001 stale-receipt error carrying the caller''s message when no pending receipt is left.';
