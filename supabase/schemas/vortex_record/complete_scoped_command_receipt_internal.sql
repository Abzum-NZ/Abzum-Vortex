create or replace function vortex_record.complete_scoped_command_receipt_internal(
  p_command_id uuid,
  p_result jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  update vortex_record.command_receipts as stored
  set result = p_result
  where stored.command_id = p_command_id
    and stored.result is null;
  if not found then
    raise exception using errcode = '40001', message = 'Command receipt is not pending';
  end if;
end
$function$;

alter function vortex_record.complete_scoped_command_receipt_internal(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_scoped_command_receipt_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.complete_scoped_command_receipt_internal(uuid, jsonb)
  to vortex_owner, postgres;

comment on function vortex_record.complete_scoped_command_receipt_internal(uuid, jsonb) is
  'Stores the result of the command this transaction claimed through claim_scoped_command_receipt_internal, or raises a 40001 error when no pending receipt is left.';
