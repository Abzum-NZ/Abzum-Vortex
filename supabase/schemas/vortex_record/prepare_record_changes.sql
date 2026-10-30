create or replace function vortex_record.prepare_record_changes(p_command_id uuid, p_subjects jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt jsonb;
  stored_result jsonb;
  projection jsonb;
  results jsonb := '[]'::jsonb;
  preparation jsonb;
  effective_command_id uuid;
  preview_installation jsonb;
  loaded jsonb;
  decision jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  preview_installation := vortex_record.read_current_preview_installation_internal();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, true);
  if receipt ->> 'status' = 'completed' then
    if pg_catalog.jsonb_typeof(receipt #> '{result,results}') is distinct from 'array'
      or pg_catalog.jsonb_array_length(receipt #> '{result,results}') not between 1 and 200 then
      raise exception using errcode = '55000', message = 'Stored record change result is invalid';
    end if;
    -- A replay uses the identities retained by the command and today's protected
    -- projections. Neither changed retry input nor previously readable values
    -- can widen current authority or disclose a stale receipt payload.
    for stored_result in
      select item.value from pg_catalog.jsonb_array_elements(receipt #> '{result,results}') as item(value)
    loop
      if stored_result ->> 'operation' in ('delete', 'restore') then
        loaded := vortex_record.load_record_access_facts_internal(
          (stored_result ->> 'recordTypeId')::uuid, stored_result ->> 'operation',
          (stored_result ->> 'recordId')::uuid, null, null
        );
        if loaded ->> 'outcome' = 'loaded' and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
          -- Recheck the original delete authority against today's retained
          -- ownership and scopes. Only rows journaled by this exact command
          -- may stand in their pre-delete lifecycle state for that decision.
          if stored_result ->> 'operation' = 'delete' then
            loaded := pg_catalog.jsonb_set(loaded, '{facts,records}', (
              select pg_catalog.jsonb_agg(case when item.value ->> 'lifecycleState' = 'soft_deleted'
                and exists (select 1 from vortex_record.record_lifecycle_command_effects as effect
                  where effect.command_id = effective_command_id and effect.effect_kind = 'soft_deleted'
                    and effect.organization_id = (context_value ->> 'organizationId')::uuid
                    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
                    and effect.record_id = (item.value #>> '{recordScope,recordId}')::uuid
                    and effect.storage_contract_id = (item.value #>> '{recordScope,storageContractId}')::uuid)
                then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active') else item.value end
                order by item.ordinality)
              from pg_catalog.jsonb_array_elements(loaded #> '{facts,records}') with ordinality as item(value, ordinality)
            ));
          end if;
          decision := vortex_access.evaluate_organization_record_access_internal(
            loaded -> 'declaration', (stored_result ->> 'recordId')::uuid, loaded -> 'facts'
          );
        else
          decision := null;
        end if;
        if decision ->> 'outcome' is distinct from 'allowed' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable',
            'correlationId', context_value -> 'correlationId');
        end if;
        results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'outcome', case stored_result ->> 'operation' when 'delete' then 'deleted' else 'restored' end,
          'recordId', stored_result -> 'recordId', 'concurrencyNumber', stored_result -> 'concurrencyNumber',
          'unrestoredLinkCount', stored_result -> 'unrestoredLinkCount',
          'correlationId', context_value -> 'correlationId', 'replayed', true
        ));
        continue;
      end if;
      projection := (vortex_record.read_record(
        (stored_result ->> 'recordTypeId')::uuid, (stored_result ->> 'recordId')::uuid
      )) -> 'record';
      if projection ->> 'outcome' is distinct from 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'outcome', 'saved', 'recordTypeId', stored_result -> 'recordTypeId',
        'recordId', projection -> 'recordId', 'concurrencyNumber', projection -> 'concurrencyNumber',
        'values', projection -> 'values', 'correlationId', context_value -> 'correlationId',
        'backgroundDelivery', case when preview_installation is null then 'pending' else 'none' end,
        'replayed', true
      ));
    end loop;
    return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', results, 'replayed', true);
  elsif receipt ->> 'status' <> 'none' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  preparation := vortex_record.prepare_record_calculation_set_internal(p_subjects);
  return preparation || pg_catalog.jsonb_build_object('correlationId', context_value -> 'correlationId');
end
$function$;
alter function vortex_record.prepare_record_changes(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_changes(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_record_changes(uuid,jsonb) to vortex_request;
comment on function vortex_record.prepare_record_changes(uuid,jsonb) is
  'Protected record-set calculation preflight and current-authority replay projection; one command identity, one locked dependency graph, no record writes.';
