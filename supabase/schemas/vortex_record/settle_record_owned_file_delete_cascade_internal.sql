create or replace function vortex_record.settle_record_owned_file_delete_cascade_internal(
  p_command_id uuid,
  p_settlements jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  settlement jsonb;
  settlement_count integer;
  effect_count integer;
  changed_rows integer;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_settlements) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record File cascade settlement is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record File cascade settlement requires an Application context';
  end if;
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete' then
    raise exception using errcode = '42501',
      message = 'Record File cascade settlement receipt is unavailable';
  end if;

  select pg_catalog.count(*) into effect_count
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id
    and effect.effect_kind = 'soft_deleted';
  select pg_catalog.count(*) into settlement_count
  from pg_catalog.jsonb_array_elements(p_settlements) as item(value);
  if effect_count < 1 or settlement_count <> effect_count
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array['effectSequence', 'proofDigest'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(item.value -> 'effectSequence') is distinct from 'number'
        or (item.value ->> 'effectSequence') !~ '^[1-9][0-9]*$'
        or pg_catalog.jsonb_typeof(item.value -> 'proofDigest') is distinct from 'string'
        or (item.value ->> 'proofDigest') !~ '^[0-9a-f]{64}$'
    )
    or (
      select pg_catalog.count(distinct (item.value ->> 'effectSequence')::integer)
      from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
    ) <> effect_count then
    raise exception using errcode = '55000',
      message = 'Record File cascade settlement is incomplete';
  end if;

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'soft_deleted'
    order by effect.effect_sequence
    for update
  loop
    select item.value into strict settlement
    from pg_catalog.jsonb_array_elements(p_settlements) as item(value)
    where (item.value ->> 'effectSequence')::integer = effect_row.effect_sequence;
    if effect_row.file_cascade_settled
      or effect_row.file_cascade_proof_digest is null
      or effect_row.file_cascade_proof_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'Record File cascade proof is unavailable';
    end if;
    update vortex_record.record_lifecycle_command_effects as effect
    set file_cascade_proof_digest = settlement ->> 'proofDigest',
      file_cascade_settled = true
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_sequence = effect_row.effect_sequence
      and effect.effect_kind = 'soft_deleted'
      and effect.file_cascade_settled = false
      and effect.file_cascade_proof_digest = effect_row.file_cascade_proof_digest;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Record File cascade settlement is stale';
    end if;
  end loop;
  if exists (
    select 1
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
      and effect.effect_kind = 'soft_deleted'
      and (not effect.file_cascade_settled
        or effect.file_cascade_proof_digest !~ '^[0-9a-f]{64}$')
  ) then
    raise exception using errcode = '55000',
      message = 'Record File cascade settlement is incomplete';
  end if;
end
$function$;

alter function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb)
  to vortex_file_owner, vortex_record_owner;
comment on function vortex_record.settle_record_owned_file_delete_cascade_internal(uuid,jsonb) is
  'Privately settles every exact pending soft_deleted lifecycle effect after the File owner completes the same-transaction CAS, storing only a SHA-256 proof and settled marker.';
