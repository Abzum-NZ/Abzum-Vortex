create or replace function vortex_record.replay_record_changes_internal(
  p_effective_command_id uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  preview_installation jsonb := vortex_record.read_current_preview_installation_internal();
  stored_result jsonb;
  projection jsonb;
  results jsonb := '[]'::jsonb;
  named_results jsonb := '[]'::jsonb;
  loaded jsonb;
  decision jsonb;
begin
  if pg_catalog.jsonb_typeof(p_result -> 'results') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_result -> 'results') > 200
    or (pg_catalog.jsonb_array_length(p_result -> 'results') = 0 and not p_result ? 'named') then
    raise exception using errcode = '55000', message = 'Stored record change result is invalid';
  end if;
  -- A replay uses the identities retained by the command and today's protected
  -- projections. Neither changed retry input nor previously readable values
  -- can widen current authority or disclose a stale receipt payload.
  for stored_result in
    select item.value from pg_catalog.jsonb_array_elements(p_result -> 'results') as item(value)
  loop
    if stored_result ->> 'operation' in ('delete', 'restore') then
      loaded := (vortex_record.load_record_access_facts_internal(stored_result ->> 'operation', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (stored_result ->> 'recordTypeId')::uuid, 'recordId', (stored_result ->> 'recordId')::uuid))) -> 0);
      if loaded ->> 'outcome' = 'loaded' and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
        -- Recheck the original delete authority against today's retained
        -- ownership and scopes. Only rows journaled by this exact command
        -- may stand in their pre-delete lifecycle state for that decision.
        if stored_result ->> 'operation' = 'delete' then
          loaded := pg_catalog.jsonb_set(loaded, '{facts,records}', (
            select pg_catalog.jsonb_agg(case when item.value ->> 'lifecycleState' = 'soft_deleted'
              and exists (select 1 from vortex_record.record_lifecycle_command_effects as effect
                where effect.command_id = p_effective_command_id and effect.effect_kind = 'soft_deleted'
                  and effect.organization_id = (context_value ->> 'organizationId')::uuid
                  and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
                  and effect.record_id = (item.value #>> '{recordScope,recordId}')::uuid
                  and effect.storage_contract_id = (item.value #>> '{recordScope,storageContractId}')::uuid)
              then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active') else item.value end
              order by item.ordinality)
            from pg_catalog.jsonb_array_elements(loaded #> '{facts,records}') with ordinality as item(value, ordinality)
          ));
        end if;
        decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (stored_result ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
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
  -- A named command replays each subject through the action's own current
  -- projection; a subject the action deleted keeps its stored deleted outcome.
  if p_result ? 'named' then
    for stored_result in
      select item.value from pg_catalog.jsonb_array_elements(p_result #> '{named,subjects}') as item(value)
    loop
      if (stored_result ->> 'deleted')::boolean then
        projection := pg_catalog.jsonb_build_object(
          'outcome', 'completed', 'recordId', stored_result -> 'recordId',
          'concurrencyNumber', stored_result -> 'concurrencyNumber', 'values', '{}'::jsonb,
          'correlationId', context_value -> 'correlationId', 'backgroundDelivery', 'pending', 'replayed', true
        );
      else
        projection := vortex_record.project_named_action_record_internal(
          p_result #>> '{named,action,ownerKind}', (p_result #>> '{named,action,ownerId}')::uuid,
          (p_result #>> '{named,action,releaseRevision}')::bigint, (p_result #>> '{named,action,actionId}')::uuid,
          (p_result #>> '{named,recordTypeId}')::uuid, (stored_result ->> 'recordId')::uuid
        );
        if projection ->> 'outcome' is distinct from 'completed' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable',
            'correlationId', context_value -> 'correlationId');
        end if;
        projection := projection || pg_catalog.jsonb_build_object('correlationId', context_value -> 'correlationId');
      end if;
      named_results := named_results || pg_catalog.jsonb_build_array(projection);
    end loop;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', results, 'replayed', true,
    'correlationId', context_value -> 'correlationId')
    || case when p_result ? 'named' then pg_catalog.jsonb_build_object('namedResults', named_results)
      else '{}'::jsonb end;
end
$function$;
alter function vortex_record.replay_record_changes_internal(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.replay_record_changes_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.replay_record_changes_internal(uuid,jsonb) is
  'Private replay of a completed record command: reprojects each retained identity (and each named subject through its action) under current authority; it never returns stored values.';
