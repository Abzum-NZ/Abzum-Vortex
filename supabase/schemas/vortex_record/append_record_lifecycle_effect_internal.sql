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
  receipt_kind text;
  effects jsonb;
begin
  bound_command_id := nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then return; end if;
  if pg_catalog.jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_effects) = 0 then return; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
    where not (item.value ?& array['effectKind', 'storageContractId', 'recordTypeId', 'recordId', 'preConcurrencyNumber', 'relationshipId', 'previousValue', 'deleteRoots'])
      or item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared', 'restored', 'links_restored')
      or pg_catalog.jsonb_typeof(item.value -> 'deleteRoots') is distinct from 'array'
      or item.value -> 'deleteRoots' = '[]'::jsonb
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(item.value -> 'deleteRoots') = 'array'
            then item.value -> 'deleteRoots' else '[]'::jsonb end) as root(value)
        where pg_catalog.jsonb_typeof(root.value) is distinct from 'object'
          or not (root.value ?& array['recordTypeId', 'recordId'])
          or root.value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
          or not vortex_platform.is_non_nil_uuid(root.value ->> 'recordTypeId')
          or not vortex_platform.is_non_nil_uuid(root.value ->> 'recordId')
      )
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
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
    group by item.value -> 'effectKind', item.value -> 'storageContractId',
      item.value -> 'recordId', item.value -> 'relationshipId'
    having pg_catalog.count(distinct (item.value - 'deleteRoots')) > 1
  ) then
    raise exception using errcode = '40001', message = 'Shared lifecycle effects disagree';
  end if;
  -- One affected row/relationship has one journal effect, even when several
  -- roots reached it. Keep every reaching root on that effect.
  select pg_catalog.jsonb_agg(grouped.effect || pg_catalog.jsonb_build_object(
    'deleteRoots', (
      select pg_catalog.jsonb_agg(roots.value order by roots.value ->> 'recordTypeId', roots.value ->> 'recordId')
      from (
        select distinct root.value
        from pg_catalog.jsonb_array_elements(p_effects) as item(value)
        cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'deleteRoots') as root(value)
        where item.value - 'deleteRoots' = grouped.effect
      ) as roots
    )
  ) order by grouped.position) into effects
  from (
    select item.value - 'deleteRoots' as effect, pg_catalog.min(item.ordinality) as position
    from pg_catalog.jsonb_array_elements(p_effects) with ordinality as item(value, ordinality)
    group by item.value - 'deleteRoots'
  ) as grouped;
  context_value := vortex_access.validated_human_request_context();
  select stored.command_kind into receipt_kind
  from vortex_record.command_receipts as stored where stored.command_id = bound_command_id;
  if receipt_kind not in ('record_delete', 'record_restore', 'record_changes')
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
      where (receipt_kind = 'record_delete' and item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared'))
        or (receipt_kind = 'record_restore' and item.value ->> 'effectKind' not in ('restored', 'links_restored'))
    ) then
    raise exception using errcode = '42501', message = 'Record lifecycle command kind is invalid';
  end if;
  receipt := vortex_record.lock_command_receipt_internal(receipt_kind, bound_command_id);
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
    pre_concurrency_number, post_concurrency_number, previous_value, delete_roots
  )
  select (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid, receipt.command_id,
    next_sequence + item.ordinality::integer, item.value ->> 'effectKind',
    (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordTypeId')::uuid,
    (item.value ->> 'recordId')::uuid, (item.value ->> 'relationshipId')::uuid,
    (item.value ->> 'preConcurrencyNumber')::bigint,
    (item.value ->> 'preConcurrencyNumber')::bigint + 1,
    nullif(item.value -> 'previousValue', 'null'::jsonb), item.value -> 'deleteRoots'
  from pg_catalog.jsonb_array_elements(effects) with ordinality as item(value, ordinality);
end
$function$;

alter function vortex_record.append_record_lifecycle_effect_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.append_record_lifecycle_effect_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.append_record_lifecycle_effect_internal(jsonb) is
  'Appends the prepared lifecycle effects in one journal write for the command bound to this transaction, retaining cleared link targets for exact recovery.';
