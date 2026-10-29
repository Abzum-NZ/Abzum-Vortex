create or replace function vortex_record.append_record_lifecycle_effect_internal(p_effects jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  next_sequence integer;
  restoring boolean;
begin
  bound_command_id := nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then return; end if;
  if pg_catalog.jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_effects) = 0 then return; end if;
  restoring := (p_effects -> 0 ->> 'effectKind') in ('restored', 'links_restored');
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
    where not (item.value ?& array['effectKind', 'storageContractId', 'recordTypeId', 'recordId', 'preConcurrencyNumber', 'relationshipId', 'previousValue'])
      or item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared', 'restored', 'links_restored')
      or ((item.value ->> 'effectKind') in ('restored', 'links_restored')) is distinct from restoring
      or (item.value ->> 'effectKind' = 'optional_cleared' and (
        pg_catalog.jsonb_typeof(item.value -> 'previousValue') is distinct from 'object'
        or not ((item.value -> 'previousValue') ?& array['recordTypeId', 'recordId'])
        or (item.value -> 'previousValue') - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value #>> '{previousValue,recordTypeId}')
        or not vortex_platform.is_non_nil_uuid(item.value #>> '{previousValue,recordId}')
      ))
      or (item.value ->> 'effectKind' <> 'optional_cleared' and item.value -> 'previousValue' <> 'null'::jsonb)
  ) then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  receipt := vortex_record.lock_command_receipt_internal(
    case when restoring then 'record_restore' else 'record_delete' end, bound_command_id
  );
  if receipt.command_id is null or receipt.result is not null then
    raise exception using errcode = '42501', message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number, previous_value
  )
  select (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid, receipt.command_id,
    next_sequence + item.ordinality::integer, item.value ->> 'effectKind',
    (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordTypeId')::uuid,
    (item.value ->> 'recordId')::uuid, (item.value ->> 'relationshipId')::uuid,
    (item.value ->> 'preConcurrencyNumber')::bigint,
    (item.value ->> 'preConcurrencyNumber')::bigint + 1,
    nullif(item.value -> 'previousValue', 'null'::jsonb)
  from pg_catalog.jsonb_array_elements(p_effects) with ordinality as item(value, ordinality);
end
$function$;

alter function vortex_record.append_record_lifecycle_effect_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.append_record_lifecycle_effect_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.append_record_lifecycle_effect_internal(jsonb) is
  'Appends the prepared lifecycle effects in one journal write for the command bound to this transaction, retaining cleared link targets for exact recovery.';
