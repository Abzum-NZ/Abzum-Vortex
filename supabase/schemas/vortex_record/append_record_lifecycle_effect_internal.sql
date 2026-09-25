create or replace function vortex_record.append_record_lifecycle_effect_internal(
  p_effect_kind text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_pre_concurrency_number bigint,
  p_relationship_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
  next_sequence integer;
begin
  bound_command_id := pg_catalog.nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then
    return;
  end if;
  receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', bound_command_id);
  if receipt.command_id is null
    or receipt.state is distinct from 'pending'
    or (receipt.operation = 'delete'
      and p_effect_kind not in ('soft_deleted', 'optional_cleared'))
    or (receipt.operation = 'restore' and p_effect_kind is distinct from 'restored') then
    raise exception using errcode = '42501',
      message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) + 1 into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number
  ) values (
    receipt.organization_id, receipt.application_root_id,
    receipt.actor_organization_account_id, receipt.command_id, next_sequence,
    p_effect_kind, p_storage_contract_id, p_record_type_id, p_record_id,
    p_relationship_id, p_pre_concurrency_number, p_pre_concurrency_number + 1
  );
end
$function$;

revoke all on function vortex_record.append_record_lifecycle_effect_internal(
  text, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.append_record_lifecycle_effect_internal(
  text, uuid, uuid, uuid, bigint, uuid
) is
  'Journals one lifecycle effect for the command bound to this transaction; it does nothing when no command is bound.';
