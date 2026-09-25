create or replace function vortex_record.complete_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_record_id uuid,
  p_concurrency_number bigint,
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
  context_value := vortex_access.validated_human_request_context();
  update vortex_record.command_receipts as stored
  set state = 'completed',
    record_id = coalesce(p_record_id, stored.record_id),
    concurrency_number = p_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = p_stale_message;
  end if;
end
$function$;

revoke all on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) to vortex_record_adapter;
comment on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) is
  'Completes the request actor''s pending command receipt with its result, or raises a 40001 stale-receipt error carrying the caller''s message when no pending receipt is left.';
