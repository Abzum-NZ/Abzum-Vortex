create or replace function vortex_record.complete_flow_segment_receipt(
  p_command_id uuid, p_result jsonb
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object'
    or pg_catalog.pg_column_size(p_result) > 65536 then
    raise exception using errcode = '22023', message = 'Flow segment result is invalid';
  end if;
  update vortex_record.command_receipts as receipt
  set result = p_result
  where receipt.command_id = p_command_id
    and receipt.organization_id = (context_value ->> 'organizationId')::uuid
    and receipt.tenant_id = (context_value ->> 'tenantId')::uuid
    and receipt.actor_id = (context_value ->> 'organizationAccountId')::uuid
    and receipt.command_kind = 'flow_segment'
    and receipt.result is null;
  if not found then
    raise exception using errcode = '40001', message = 'Flow segment receipt is not pending';
  end if;
end
$function$;

alter function vortex_record.complete_flow_segment_receipt(uuid, jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_flow_segment_receipt(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_flow_segment_receipt(uuid, jsonb) to vortex_request, postgres;
comment on function vortex_record.complete_flow_segment_receipt(uuid, jsonb) is
  'Completes the current human request scope''s pending flow segment receipt.';
