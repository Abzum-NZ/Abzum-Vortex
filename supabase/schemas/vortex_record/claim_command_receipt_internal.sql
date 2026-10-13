create or replace function vortex_record.claim_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_replay_only boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  tenant_id_value uuid;
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  tenant_id_value := (context_value ->> 'tenantId')::uuid;

  -- The command id is claimed as pending (no result yet). A claim that finds an
  -- existing receipt locks it and classifies it; a replay-only read classifies
  -- without inserting or locking.
  if not p_replay_only then
    insert into vortex_record.command_receipts (
      command_id, organization_id, tenant_id, command_kind
    ) values (
      p_command_id, organization_id_value, tenant_id_value, p_command_kind
    )
    on conflict (command_id) do nothing
    returning command_id into inserted_command_id;
    if inserted_command_id is not null then
      return pg_catalog.jsonb_build_object('status', 'claimed');
    end if;
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.command_id = p_command_id
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Command receipt was released while it was claimed';
    end if;
  else
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.command_id = p_command_id;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
  end if;

  -- A command id replays only inside the scope that stored it.
  if receipt.organization_id is distinct from organization_id_value
    or receipt.tenant_id is distinct from tenant_id_value
    or receipt.command_kind is distinct from p_command_kind then
    return pg_catalog.jsonb_build_object('status', 'identity_conflict');
  end if;
  if receipt.result is null then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'recordId', receipt.result -> 'recordId',
    'concurrencyNumber', receipt.result -> 'concurrencyNumber'
  );
end
$function$;

alter function vortex_record.claim_command_receipt_internal(text,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) to vortex_record_adapter;
comment on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) is
  'The one command-receipt claim and replay classifier. Claims the command id as pending, or classifies its receipt as identity_conflict (stored under another organisation, tenant or command kind), pending or completed with its stored result; with p_replay_only it only reads, returning none when there is no receipt.';
