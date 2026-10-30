create or replace function vortex_record.complete_record_lifecycle_set_internal(
  p_command_id uuid,
  p_preparation jsonb,
  p_written jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  plan jsonb;
  subject_ids uuid[];
  event_kind text;
  event_result jsonb;
  revision_value bigint;
  notice_sequence bigint;
  storage_value record;
begin
  -- The journal has already deduplicated shared closures. Each effect emits
  -- once, irrespective of how many explicit roots reached the affected row.
  for effect_row in
    select effect.* from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind in ('soft_deleted', 'optional_cleared', 'restored') then
      event_kind := case effect_row.effect_kind
        when 'soft_deleted' then 'deleted' when 'restored' then 'restored' else 'unlinked' end;
      event_result := vortex_platform.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', pg_catalog.gen_random_uuid(),
          'descriptor', pg_catalog.jsonb_build_object('kind', 'standard',
            'eventKind', event_kind, 'recordTypeId', effect_row.record_type_id),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array'
        or pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000', message = 'Record lifecycle Event append failed';
      end if;
    end if;
  end loop;
  -- Every changed lifecycle row publishes its revision, including optional links
  -- cleared or recovered.
  for storage_value in
    select effect.record_type_id, effect.record_id, effect.storage_contract_id,
      storage.storage_scope, pg_catalog.bool_or(effect.effect_kind = 'soft_deleted') as deleted
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.storage_catalogue as storage using (storage_contract_id)
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
    group by effect.record_type_id, effect.record_id, effect.storage_contract_id, storage.storage_scope
  loop
    select (item.value ->> 'concurrencyNumber')::bigint into strict revision_value
    from pg_catalog.jsonb_array_elements(p_written) as item(value)
    where (item.value ->> 'storageContractId')::uuid = storage_value.storage_contract_id
      and (item.value ->> 'recordId')::uuid = storage_value.record_id;
    if storage_value.storage_scope = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
        perform vortex_platform.publish_change_notice(
          (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
          storage_value.record_type_id, storage_value.record_id, revision_value,
          case when storage_value.deleted then 'deleted' else 'changed' end,
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        raise warning 'Record lifecycle notice failed: [%] %', sqlstate, sqlerrm;
      end;
    end if;
  end loop;
  for storage_value in
    select distinct effect.storage_contract_id, storage.storage_scope
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.storage_catalogue as storage using (storage_contract_id)
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id and (storage.storage_scope <> 'application_contained'
        or effect.effect_kind in ('optional_cleared', 'links_restored'))
  loop
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid, storage_value.storage_contract_id,
      case when storage_value.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end loop;
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    where item.value #>> '{subject,operation}' in ('delete', 'restore')
  loop
    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id) into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
      and effect.delete_roots @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', plan #> '{subject,recordTypeId}', 'recordId', plan #> '{subject,recordId}'
      ));
    if subject_ids is null then
      raise exception using errcode = '55000', message = 'Record lifecycle effects are unavailable';
    end if;
    perform vortex_record.append_record_activity_internal(
      (plan #>> '{subject,activityId}')::uuid,
      case plan #>> '{subject,operation}' when 'delete' then 'delete_record' else 'restore_record' end,
      subject_ids, array[]::uuid[], 'completed'
    );
  end loop;
end
$function$;
alter function vortex_record.complete_record_lifecycle_set_internal(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_record_lifecycle_set_internal(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_record_lifecycle_set_internal(uuid,jsonb,jsonb) is
  'Completes the common record command lifecycle effects: one Event per deduplicated delete, clear or restore effect, current revisions and data versions for changed rows, and Activity for each explicit lifecycle root.';
