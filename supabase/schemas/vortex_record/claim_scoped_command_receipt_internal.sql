create or replace function vortex_record.claim_scoped_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_organization_id uuid,
  p_tenant_id uuid,
  p_actor_id uuid,
  p_conflict_message text,
  p_conflict_errcode text default 'V3001'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  -- Claims the command id for the scope the caller names (an organisation command sets
  -- organisation, tenant and actor; a tenant command sets the tenant; a platform command sets
  -- neither organisation nor tenant). The caller completes the receipt in the same transaction.
  insert into vortex_record.command_receipts (
    command_id, organization_id, tenant_id, actor_id, command_kind
  ) values (
    p_command_id, p_organization_id, p_tenant_id, p_actor_id, p_command_kind
  )
  on conflict (command_id) do nothing
  returning command_id into inserted_command_id;
  if inserted_command_id is not null then
    return null;
  end if;
  select stored.* into receipt
  from vortex_record.command_receipts as stored
  where stored.command_id = p_command_id
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Command receipt was released while it was claimed';
  end if;
  -- A command id replays only inside the scope and kind that stored it.
  if receipt.organization_id is distinct from p_organization_id
    or receipt.tenant_id is distinct from p_tenant_id
    or receipt.actor_id is distinct from p_actor_id
    or receipt.command_kind is distinct from p_command_kind then
    raise exception using errcode = p_conflict_errcode, message = p_conflict_message;
  end if;
  if receipt.result is null then
    raise exception using errcode = '40001', message = 'Command receipt is still pending';
  end if;
  return receipt.result;
end
$function$;

alter function vortex_record.claim_scoped_command_receipt_internal(text,uuid,uuid,uuid,uuid,text,text) owner to vortex_record_adapter;

revoke all on function vortex_record.claim_scoped_command_receipt_internal(
  text, uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.claim_scoped_command_receipt_internal(
  text, uuid, uuid, uuid, uuid, text, text
) to vortex_owner, postgres;

comment on function vortex_record.claim_scoped_command_receipt_internal(
  text, uuid, uuid, uuid, uuid, text, text
) is
  'Claims a command id for an explicit organisation, tenant and actor scope (used by Identity and Access commands, which run outside a Record request). Returns null for a new claim, the stored result for a replay inside the same organisation, tenant, actor and command kind, and raises the caller''s error code (V3001 unless the caller names another) with the caller''s message when the id was stored under another scope or kind.';
