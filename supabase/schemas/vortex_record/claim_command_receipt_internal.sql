create or replace function vortex_record.claim_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_operation text,
  p_fingerprint text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_identity jsonb,
  p_details jsonb,
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
  application_root_id_value uuid;
  actor_id_value uuid;
  identity_value jsonb := coalesce(p_identity, '{}'::jsonb);
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;

  -- The command identity is claimed as pending. A claim that finds an existing
  -- receipt locks it and classifies it; a replay-only read classifies without
  -- inserting or locking.
  if not p_replay_only then
    insert into vortex_record.command_receipts (
      organization_id, application_root_id, actor_organization_account_id,
      command_kind, command_id, operation, command_fingerprint, record_type_id,
      record_id, command_identity, expected_concurrency_number, recovery_policy_revision,
      activity_id, occurrence_id, state
    ) values (
      organization_id_value, application_root_id_value, actor_id_value,
      p_command_kind, p_command_id, p_operation, p_fingerprint, p_record_type_id,
      p_record_id, identity_value,
      (p_details ->> 'expectedConcurrencyNumber')::bigint,
      (p_details ->> 'recoveryPolicyRevision')::bigint,
      (p_details ->> 'activityId')::uuid,
      (p_details ->> 'occurrenceId')::uuid,
      'pending'
    )
    on conflict do nothing
    returning command_id into inserted_command_id;
    if inserted_command_id is not null then
      return pg_catalog.jsonb_build_object('status', 'claimed');
    end if;
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    for update;
  else
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
  end if;

  if not found
    or receipt.command_fingerprint is distinct from p_fingerprint
    or receipt.operation is distinct from p_operation
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.command_identity is distinct from identity_value
    or (p_record_id is not null and receipt.record_id is distinct from p_record_id) then
    return pg_catalog.jsonb_build_object('status', 'identity_conflict');
  end if;
  if receipt.state is distinct from 'completed' then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'recordId', receipt.record_id,
    'concurrencyNumber', receipt.concurrency_number
  );
end
$function$;

revoke all on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) to vortex_record_adapter;
comment on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) is
  'The one command-receipt claim and replay classifier. Claims the request actor''s command identity as pending, or classifies the existing receipt as identity_conflict, pending or completed with its stored result; with p_replay_only it only reads, returning none when there is no receipt.';
