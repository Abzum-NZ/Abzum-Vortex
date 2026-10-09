create or replace function vortex_record.read_record_restore_inventory_command_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  fingerprint_value text;
  effect_count integer;
  selected_record jsonb;
  authority jsonb;
  target_effect jsonb;
  inventory_value jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023',
      message = 'Record restore inventory command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore inventory requires an Application context';
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id,
    p_expected_concurrency_number
  );

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
    or receipt.operation is distinct from 'restore'
    or receipt.command_fingerprint is distinct from fingerprint_value
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '42501',
      message = 'Record restore inventory receipt is unavailable';
  end if;

  select pg_catalog.count(*) into effect_count
  from (
    select 1
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
    limit 2
  ) as bounded_effects;

  if effect_count = 0 then
    selected_record := vortex_record.read_recoverable_record_for_restore(
      p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if selected_record ->> 'outcome' is distinct from 'available'
      or (selected_record #>> '{record,recordId}')::uuid is distinct from p_record_id
      or (selected_record #>> '{record,revision}')::bigint
        is distinct from p_expected_concurrency_number
      or pg_catalog.jsonb_typeof(selected_record -> 'inventory') is distinct from 'object' then
      raise exception using errcode = '42501',
        message = 'Record restore inventory selection is unavailable';
    end if;
    inventory_value := selected_record -> 'inventory';
    authority := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'effects', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', inventory_value -> 'storageContractId',
        'moduleRootId', inventory_value -> 'moduleRootId',
        'moduleReleaseRevision', inventory_value -> 'moduleReleaseRevision',
        'storageScope', inventory_value -> 'storageScope',
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'preConcurrencyNumber', p_expected_concurrency_number,
        'postConcurrencyNumber', p_expected_concurrency_number + 1,
        'attachmentFields', inventory_value -> 'attachmentFields'
      ))
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'available', 'phase', 'before_restore',
      'inventory', inventory_value, 'authority', authority
    );
  elsif effect_count = 1 then
    authority := vortex_record.read_record_owned_file_restore_authority_internal(
      p_command_id
    );
    if authority ->> 'outcome' is distinct from 'prepared'
      or pg_catalog.jsonb_typeof(authority -> 'effects') is distinct from 'array'
      or pg_catalog.jsonb_array_length(authority -> 'effects') <> 1 then
      raise exception using errcode = '42501',
        message = 'Record restore inventory effect is unavailable';
    end if;
    select item.value into strict target_effect
    from pg_catalog.jsonb_array_elements(authority -> 'effects') as item(value)
    limit 1;
    if (target_effect ->> 'recordTypeId')::uuid is distinct from p_record_type_id
      or (target_effect ->> 'recordId')::uuid is distinct from p_record_id
      or (target_effect ->> 'preConcurrencyNumber')::bigint
        is distinct from p_expected_concurrency_number then
      raise exception using errcode = '42501',
        message = 'Record restore inventory effect is unavailable';
    end if;
    inventory_value := pg_catalog.jsonb_build_object(
      'storageContractId', target_effect -> 'storageContractId',
      'moduleRootId', target_effect -> 'moduleRootId',
      'moduleReleaseRevision', target_effect -> 'moduleReleaseRevision',
      'storageScope', target_effect -> 'storageScope',
      'originalDeletedAt', target_effect -> 'originalDeletedAt',
      'recoveryPolicyRevision', target_effect -> 'recoveryPolicyRevision',
      'recoveryWindowDays', target_effect -> 'recoveryWindowDays',
      'attachmentFields', target_effect -> 'attachmentFields'
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'available', 'phase', 'after_restore',
      'inventory', inventory_value, 'authority', authority
    );
  end if;

  raise exception using errcode = '55000',
    message = 'Record restore inventory effects are incomplete';
end
$function$;

alter function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_inventory, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint)
  to vortex_record_owner;
comment on function vortex_record.read_record_restore_inventory_command_internal(uuid,uuid,uuid,bigint) is
  'Adapter-owned proof bridge for the protected Record restore inventory lock: it binds the current HUMAN organization, Application and account to the pending command fingerprint and exact target, then returns only the pretransition restore selection or the existing verified posttransition authority.';
