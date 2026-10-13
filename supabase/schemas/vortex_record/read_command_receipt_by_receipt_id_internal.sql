create or replace function vortex_record.read_command_receipt_by_receipt_id_internal(
  p_command_kind text,
  p_receipt_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  receipt vortex_record.command_receipts%rowtype;
begin
  -- Finds a completed receipt of one command kind by the receipt id (correlation id) that its
  -- result stores, which is not the command id. Returns null when none matches.
  select stored.* into receipt
  from vortex_record.command_receipts as stored
  where stored.command_kind = p_command_kind
    and stored.result is not null
    and stored.result ->> 'receiptId' = p_receipt_id::text
  order by stored.command_id
  limit 1;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'tenantId', receipt.tenant_id,
    'actorId', receipt.actor_id,
    'result', receipt.result
  );
end
$function$;

alter function vortex_record.read_command_receipt_by_receipt_id_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_command_receipt_by_receipt_id_internal(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.read_command_receipt_by_receipt_id_internal(text, uuid)
  to vortex_owner, postgres;

comment on function vortex_record.read_command_receipt_by_receipt_id_internal(text, uuid) is
  'Reads a completed command receipt of one command kind by the receipt id stored in its result (the correlation id of the original command), returning its tenant, actor and result as jsonb, or null when no receipt matches.';
