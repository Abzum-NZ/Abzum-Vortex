create or replace function vortex_record.release_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid
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
  context_value := vortex_access.validated_human_request_context();
  delete from vortex_record.command_receipts as stored
  where stored.command_id = p_command_id
    and stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.tenant_id = (context_value ->> 'tenantId')::uuid
    and stored.actor_id = (context_value ->> 'organizationAccountId')::uuid
    and stored.command_kind = p_command_kind
    and stored.result is null;
end
$function$;

alter function vortex_record.release_command_receipt_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.release_command_receipt_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.release_command_receipt_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.release_command_receipt_internal(
  text, uuid
) is
  'Releases the request scope''s pending command receipt when its command is refused before any change, so the command id can be used again.';
