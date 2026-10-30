set role vortex_record_adapter;

drop function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid);
drop function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb);

create or replace function vortex_record.proposed_update_facts_internal(
  p_loaded jsonb,
  p_record_id uuid,
  p_final_values jsonb,
  p_relationship_changes jsonb,
  p_records jsonb,
  p_edges jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  proposed_field_values jsonb := (p_loaded -> 'fieldValues') || p_final_values;
  proposed_records jsonb;
  proposed_edges jsonb;
begin
  -- Target closures may reach the source through a currently permitted
  -- relationship route. Assemble all trusted closures first, then make the
  -- source authoritative exactly once so an old source copy cannot compete
  -- with the proposed values. Other repeated closure records are collapsed by
  -- their permanent Record identity.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case when unique_record.record_id = p_record_id
        then unique_record.value || pg_catalog.jsonb_build_object(
          'fieldValues', proposed_field_values
        )
        else unique_record.value end
      order by unique_record.record_id
    )
    from (
      select distinct on (
        (record.value -> 'recordScope' ->> 'recordId')::uuid
      )
        (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
        record.value
      from pg_catalog.jsonb_array_elements(p_records) as record(value)
      order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
        record.value::text collate "C"
    ) as unique_record
  ), '[]'::jsonb);

  -- Apply every changed fixed relationship after closure assembly. This one
  -- replacement pass removes old source edges even when a target closure
  -- contained them, then adds only the submitted non-null replacements.
  proposed_edges := coalesce((
    with retained_edges as (
      select edge.value
      from pg_catalog.jsonb_array_elements(p_edges) as edge(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_relationship_changes) as changed(value)
        where (changed.value ->> 'relationshipId')::uuid =
            (edge.value ->> 'relationshipId')::uuid
          and (edge.value ->> 'fromRecordId')::uuid = p_record_id
      )
    ), replacement_edges as (
      select pg_catalog.jsonb_build_object(
        'relationshipId', changed.value -> 'relationshipId',
        'fromRecordId', p_record_id,
        'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
      ) as value
      from pg_catalog.jsonb_array_elements(p_relationship_changes) as changed(value)
      where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
    ), unique_edges as (
      select distinct candidate.value
      from (
        select retained.value from retained_edges as retained
        union all
        select replacement.value from replacement_edges as replacement
      ) as candidate(value)
    )
    select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
    from unique_edges as unique_edge
  ), '[]'::jsonb);

  return (p_loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'records', proposed_records,
    'edges', proposed_edges
  );
end
$function$;
alter function vortex_record.proposed_update_facts_internal(jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.proposed_update_facts_internal(jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.proposed_update_facts_internal(jsonb,uuid,jsonb,jsonb,jsonb,jsonb) is
  'Private pure step of record update preparation: the complete proposed source facts (closure records collapsed by identity, the source carrying its proposed values, changed fixed relationships replaced) that the proposed-state access decision is made on; one definition for the per-record and the set-wide decision.';

create or replace function vortex_record.proposed_change_facts_internal(
  p_loaded jsonb,
  p_record_id uuid,
  p_final_values jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  proposed_values jsonb := p_loaded -> 'fieldValues';
  entry_key text;
  entry_value jsonb;
  proposed_records jsonb;
begin
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(p_loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  return pg_catalog.jsonb_build_object(
    'values', proposed_values,
    'facts', (p_loaded -> 'facts') || pg_catalog.jsonb_build_object('records', proposed_records)
  );
end
$function$;
alter function vortex_record.proposed_change_facts_internal(jsonb,uuid,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.proposed_change_facts_internal(jsonb,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.proposed_change_facts_internal(jsonb,uuid,jsonb) is
  'Private pure step of record change preparation: the record''s proposed field values and the loaded facts carrying them, which the proposed-state access decision is made on; one definition for the per-record and the set-wide decision.';

create or replace function vortex_record.record_field_bounds_key_internal(
  p_decision jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'outcome', p_decision -> 'outcome', 'organizationId', p_decision -> 'organizationId',
    'action', p_decision -> 'action', 'recordBinding', p_decision -> 'recordBinding',
    'matchedContributions', p_decision -> 'matchedContributions'
  )::text, 'UTF8')), 'hex')
$function$;
alter function vortex_record.record_field_bounds_key_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_field_bounds_key_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_field_bounds_key_internal(jsonb) is
  'Private key of the parts of an access decision the field bounds are taken from (outcome, organisation, action, record binding and matched contributions), so two decisions for different records that match the same contributions share one set of bounds. It must list every decision part vortex_access.resolve_record_field_bounds_internal and vortex_record.decide_record_field_bounds_internal read.';

create or replace function vortex_record.remembered_record_field_bounds_internal(
  p_memo jsonb,
  p_decision jsonb,
  p_kind text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  remembered jsonb;
begin
  -- The field bounds the whole set already took from this exact decision (found by its bounds key) are reused; the bounds of any other decision are taken now.
  if p_memo is not null then
    remembered := p_memo -> 'bounds' -> vortex_record.record_field_bounds_key_internal(p_decision) -> p_kind;
    if remembered is not null then return remembered; end if;
  end if;
  return case p_kind
    when 'resolved' then vortex_access.resolve_record_field_bounds_internal(p_decision)
    else vortex_record.decide_record_field_bounds_internal(p_decision) end;
end
$function$;
alter function vortex_record.remembered_record_field_bounds_internal(jsonb,jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.remembered_record_field_bounds_internal(jsonb,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.remembered_record_field_bounds_internal(jsonb,jsonb,text) is
  'Private field bounds of one allowed record access decision (resolved: the matched contributions'' field policies; decided: those with produced fields withheld) that reuse the bounds a set preparation already took from the identical decision, and otherwise take them now.';

create or replace function vortex_record.relationship_change_target_internal(
  p_change jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  -- The exact target a submitted link names, or null when the value is not a well-formed target
  -- the relationship declares. A link cleared to null names no target and is not asked here.
  if pg_catalog.jsonb_typeof(p_change -> 'value') <> 'object'
    or not ((p_change -> 'value') ?& array['recordTypeId', 'recordId'])
    or (p_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
    or not pg_catalog.pg_input_is_valid(p_change -> 'value' ->> 'recordTypeId', 'uuid')
    or not pg_catalog.pg_input_is_valid(p_change -> 'value' ->> 'recordId', 'uuid')
    or (p_change -> 'value' ->> 'recordTypeId')::uuid = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_change -> 'value' ->> 'recordId')::uuid = '00000000-0000-0000-0000-000000000000'::uuid then
    return null;
  end if;
  if not vortex_record.relationship_declares_target_internal(
    p_change -> 'relationship', (p_change -> 'value' ->> 'recordTypeId')::uuid
  ) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'recordTypeId', (p_change -> 'value' ->> 'recordTypeId')::uuid,
    'recordId', (p_change -> 'value' ->> 'recordId')::uuid
  );
end
$function$;
alter function vortex_record.relationship_change_target_internal(jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.relationship_change_target_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.relationship_change_target_internal(jsonb) is
  'Private pure step of record update preparation: the exact target record a submitted link names when the value is well formed and the relationship declares that record type; one definition for the set-wide target load and the per-record link checks.';

create or replace function vortex_record.record_access_decision_memo_internal(
  p_entries jsonb,
  p_memo jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  decision_chunk record;
  decisions jsonb;
  decided jsonb := '[]'::jsonb;
  bounds_memo jsonb;
begin
  -- Each entry names its owner (the position of the record intent it answers for) and one exact
  -- access input. The whole set is decided together, never one call per record: each distinct
  -- input is decided once, in calls of at most 200. A decision is remembered under the digest of
  -- its exact input, so a memo never answers for a different declaration, record or facts, and
  -- the field bounds of every distinct allowed decision are taken once, not once per record.
  -- The decisions of an earlier memo are kept.
  if p_entries is null or pg_catalog.jsonb_array_length(p_entries) = 0 then
    return coalesce(p_memo, '{}'::jsonb);
  end if;
  for decision_chunk in
    select numbered.chunk, pg_catalog.jsonb_agg(numbered.input order by numbered.position) as inputs,
      pg_catalog.array_agg(numbered.digest order by numbered.position) as digests
    from (
      select distinct_input.digest, distinct_input.input,
        pg_catalog.row_number() over (order by distinct_input.digest) as position,
        (pg_catalog.row_number() over (order by distinct_input.digest) - 1) / 200 as chunk
      from (
        select distinct on (digest) entry.digest, entry.input
        from (
          select item.value -> 'input' as input,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((item.value -> 'input')::text, 'UTF8')), 'hex') as digest
          from pg_catalog.jsonb_array_elements(p_entries) as item(value)
        ) as entry
        order by entry.digest
      ) as distinct_input
    ) as numbered
    group by numbered.chunk
    order by numbered.chunk
  loop
    decisions := vortex_access.evaluate_organization_record_access_internal(decision_chunk.inputs);
    decided := decided || (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'digest', decision_chunk.digests[decision.ordinality], 'decision', decision.value)
        order by decision.ordinality)
      from pg_catalog.jsonb_array_elements(decisions) with ordinality as decision(value, ordinality));
  end loop;

  select coalesce(pg_catalog.jsonb_object_agg(distinct_decision.key, pg_catalog.jsonb_build_object(
      'resolved', vortex_access.resolve_record_field_bounds_internal(distinct_decision.decision),
      'decided', vortex_record.decide_record_field_bounds_internal(distinct_decision.decision))), '{}'::jsonb)
  into bounds_memo
  from (
    select distinct on (vortex_record.record_field_bounds_key_internal(entry.value -> 'decision'))
      vortex_record.record_field_bounds_key_internal(entry.value -> 'decision') as key,
      entry.value -> 'decision' as decision
    from pg_catalog.jsonb_array_elements(decided) as entry(value)
    where entry.value #>> '{decision,outcome}' = 'allowed'
  ) as distinct_decision;
  bounds_memo := coalesce((select first_owner.value -> 'bounds' from pg_catalog.jsonb_each(coalesce(p_memo, '{}'::jsonb)) as first_owner limit 1), '{}'::jsonb)
    || bounds_memo;

  return (
    select coalesce(pg_catalog.jsonb_object_agg(owned.owner, pg_catalog.jsonb_build_object(
      'decisions', owned.entries, 'bounds', bounds_memo)), '{}'::jsonb)
    from (
      select answered.owner, pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('digest', answered.digest, 'decision', answered.decision)
        order by answered.stage, answered.position) as entries
      from (
        select previous.key as owner, 0 as stage, remembered.ordinality as position,
          remembered.value ->> 'digest' as digest, remembered.value -> 'decision' as decision
        from pg_catalog.jsonb_each(coalesce(p_memo, '{}'::jsonb)) as previous(key, value)
        cross join lateral pg_catalog.jsonb_array_elements(previous.value -> 'decisions')
          with ordinality as remembered(value, ordinality)
        union all
        select item.owner, 1, item.position, item.digest, known.value -> 'decision'
        from (
          select entry.value ->> 'owner' as owner, entry.ordinality as position,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((entry.value -> 'input')::text, 'UTF8')), 'hex') as digest
          from pg_catalog.jsonb_array_elements(p_entries) with ordinality as entry(value, ordinality)
        ) as item
        join pg_catalog.jsonb_array_elements(decided) as known(value)
          on known.value ->> 'digest' = item.digest
      ) as answered
      group by answered.owner
    ) as owned
  );
end
$function$;
alter function vortex_record.record_access_decision_memo_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_access_decision_memo_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_access_decision_memo_internal(jsonb,jsonb) is
  'Private set-wide access decisions: decides every distinct entry input once, in calls of at most 200, and returns per owner the decisions (by digest of their input) and the field bounds of each distinct allowed decision, for decide_record_access_internal and remembered_record_field_bounds_internal to reuse; an earlier memo''s decisions are kept.';

create or replace function vortex_record.prepare_record_values_internal(
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_type_context jsonb default null,
  p_loaded jsonb default null,
  p_memo jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  organization_id_value uuid;
  correlation_id_value uuid;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  meta := coalesce(p_type_context -> 'meta', vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  ));
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- Ordinary saves require the explicit operation; named actions use their own preparation.
  if not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false) then
    raise log 'Record save preparation refused: standard operation % is not declared', p_operation;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'correlationId', correlation_id_value
    );
  end if;
  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_platform_system_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := (vortex_record.load_record_access_facts_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id
      ))
    ) -> 0);
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', loaded -> 'declaration',
          'recordId', p_record_id,
          'facts', loaded -> 'facts'
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveFlows', coalesce(p_type_context -> 'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      )),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := coalesce(p_loaded, (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      ))
    ) -> 0));
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_record.decide_record_access_internal(
        p_memo, loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.remembered_record_field_bounds_internal(p_memo, decision, 'decided');
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- The owning Module release's BeforeSave flows for this record type, run by Record.
    'beforeSaveFlows', coalesce(p_type_context -> 'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    )),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb,jsonb,jsonb) is
  'Private operation-scoped value and BeforeSave preparation under current authority; receipt handling belongs to the enclosing record command.';

create or replace function vortex_record.prepare_record_calculation_set_internal(
  p_subjects jsonb,
  p_named_roles jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  subject jsonb;
  subject_index integer;
  root_key text;
  roots jsonb := '[]'::jsonb;
  root_keys text[] := array[]::text[];
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  loaded jsonb;
  decision jsonb;
  prepared jsonb;
  subjects jsonb := '[]'::jsonb;
  prepared_subjects jsonb[] := array[]::jsonb[];
  proposals jsonb;
  graph jsonb;
  meta jsonb;
  projection_records jsonb := '[]'::jsonb;
  preview_installation jsonb;
  lifecycle jsonb;
  named_prepared jsonb;
  meta_cache jsonb := '{}'::jsonb;
  type_contexts jsonb := '{}'::jsonb;
  cache_key text;
  update_targets jsonb := '[]'::jsonb;
  update_indexes integer[] := array[]::integer[];
  update_loaded jsonb[] := array[]::jsonb[];
  update_decisions jsonb[] := array[]::jsonb[];
  locked_targets jsonb := '[]'::jsonb;
  locked_loaded jsonb[] := array[]::jsonb[];
  locked_memo jsonb := '{}'::jsonb;
  loaded_set jsonb;
  decision_set jsonb;
  set_position integer;
  target_position integer;
begin
  if not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  catalogue := case when preview_installation is null
    then vortex_record.relationship_total_catalogue_internal() else '{}'::jsonb end;
  lifecycle := vortex_record.prepare_record_lifecycle_set_internal(p_subjects);
  if lifecycle ->> 'outcome' is distinct from 'prepared' then return lifecycle; end if;
  catalogue := catalogue || pg_catalog.jsonb_build_object('proposedRecords', lifecycle -> 'snapshots');
  roots := lifecycle -> 'roots';
  subjects := lifecycle -> 'subjects';
  select coalesce(pg_catalog.array_agg(item.value ->> 'recordKey'), array[]::text[]) into root_keys
  from pg_catalog.jsonb_array_elements(subjects) as item(value);
  -- Resolve each record type's context once, and decide the access of every plain update
  -- source with one facts load and one decision for the whole set.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      continue;
    end if;
    cache_key := (subject ->> 'recordTypeId') || ':' || (subject ->> 'operation');
    if not meta_cache ? cache_key then
      meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
        vortex_record.resolve_record_action_context_internal(
          (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
        ));
      -- The record type's BeforeSave flows are read once here, not again for every record.
      type_contexts := type_contexts || pg_catalog.jsonb_build_object(cache_key, pg_catalog.jsonb_build_object(
        'meta', meta_cache -> cache_key,
        'beforeSaveFlows', case
          when pg_catalog.jsonb_typeof(meta_cache -> cache_key -> 'recordType') = 'object'
            and not (meta_cache -> cache_key -> 'recordType' ? 'systemProjection')
          then vortex_record.before_save_flows_for_record_type_internal(
            (meta_cache -> cache_key ->> 'moduleRootId')::uuid,
            (meta_cache -> cache_key ->> 'moduleReleaseRevision')::bigint,
            (subject ->> 'recordTypeId')::uuid
          ) end
      ));
    end if;
    if subject ->> 'operation' = 'update' and preview_installation is null
      and not (meta_cache -> cache_key -> 'recordType' ? 'systemProjection')
      and vortex_record.named_record_change_values_internal(p_named_roles, subject_index) is null then
      update_targets := update_targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId'
      ));
      update_indexes := pg_catalog.array_append(update_indexes, subject_index);
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(update_targets) > 0 then
    loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'declaration', loaded.value -> 'declaration',
        'recordId', update_targets -> (loaded.ordinality - 1)::integer -> 'recordId',
        'facts', loaded.value -> 'facts'
      ) order by loaded.ordinality)
    into decision_set
    from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality)
    where loaded.value ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(loaded.value -> 'declaration') = 'object';
    if decision_set is not null then
      decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
    end if;
    set_position := 0;
    for target_position in 1 .. pg_catalog.jsonb_array_length(loaded_set) loop
      update_loaded[update_indexes[target_position] + 1] := loaded_set -> (target_position - 1);
      if loaded_set -> (target_position - 1) ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded_set -> (target_position - 1) -> 'declaration') = 'object' then
        update_decisions[update_indexes[target_position] + 1] := decision_set -> set_position;
        set_position := set_position + 1;
      end if;
    end loop;
  end if;
  -- Authorize every explicit source before reading or locking its dependencies.
  -- A null expected revision is the existing loader's non-locking read mode.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      continue;
    end if;
    named_prepared := vortex_record.named_record_change_values_internal(p_named_roles, subject_index);
    meta := meta_cache -> ((subject ->> 'recordTypeId') || ':' || (subject ->> 'operation'));
    if preview_installation is not null or meta -> 'recordType' ? 'systemProjection' then
      prepared := coalesce(named_prepared, vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid,
        type_contexts -> ((subject ->> 'recordTypeId') || ':' || (subject ->> 'operation'))
      ));
      if prepared ->> 'outcome' is distinct from 'prepared' then
        return prepared || pg_catalog.jsonb_build_object('index', subject_index);
      end if;
      projection_records := projection_records || pg_catalog.jsonb_build_array(
        prepared || pg_catalog.jsonb_build_object(
          'recordKey', 'intent:' || subject_index::text, 'recordTypeId', subject -> 'recordTypeId',
          'canRead', true, 'relationshipSources', '[]'::jsonb
        ) || case when subject ->> 'operation' = 'create' then '{}'::jsonb
          else pg_catalog.jsonb_build_object('recordId', subject -> 'recordId',
            'concurrencyNumber', subject -> 'expectedConcurrencyNumber') end
      );
      continue;
    end if;
    if named_prepared is not null then
      -- The action's own authority and revision were verified with the named scope.
      null;
    elsif subject ->> 'operation' = 'update' then
      loaded := update_loaded[subject_index + 1];
      if loaded ->> 'outcome' is distinct from 'loaded'
        or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      decision := update_decisions[subject_index + 1];
      if decision ->> 'outcome' is distinct from 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      if (loaded ->> 'concurrencyNumber')::bigint
        is distinct from (subject ->> 'expectedConcurrencyNumber')::bigint then
        return pg_catalog.jsonb_build_object('outcome', 'conflict', 'index', subject_index);
      end if;
    else
      -- A plain create has no stored record to authorize here; its values are prepared once
      -- below, after the closure is locked.
      null;
    end if;
    root_key := 'intent:' || subject_index::text;
    roots := roots || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', root_key, 'operation', subject -> 'operation',
      'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId',
      'values', subject -> 'submittedValues'
    ));
    root_keys := pg_catalog.array_append(root_keys, root_key);
  end loop;
  before_closure := vortex_record.record_change_total_closure_internal(catalogue, roots);
  if before_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
  end if;
  if before_closure ->> 'outcome' = 'refused' then return before_closure; end if;
  if (before_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records) > 1000 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_change_too_large');
  end if;
  for record_value in
    select item.value from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue, (record_value ->> 'recordTypeId')::uuid, (record_value ->> 'recordId')::uuid, true
    ) is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;
  after_closure := vortex_record.record_change_total_closure_internal(catalogue, roots);
  if after_closure ->> 'outcome' = 'refused' then return after_closure; end if;
  if after_closure is null or before_closure -> 'signatures' is distinct from after_closure -> 'signatures'
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- Reuse current access, field policy, metadata and rule preparation after the
  -- complete concrete union is locked. No record or receipt is written here. Every plain
  -- update source is loaded again at its expected revision and decided again with one load
  -- and one decision for the whole set.
  if pg_catalog.cardinality(update_indexes) > 0 then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'recordTypeId', p_subjects -> index_value -> 'recordTypeId',
      'recordId', p_subjects -> index_value -> 'recordId',
      'expectedConcurrencyNumber', p_subjects -> index_value -> 'expectedConcurrencyNumber'
    ) order by position)
    into locked_targets
    from pg_catalog.unnest(update_indexes) with ordinality as target(index_value, position);
    loaded_set := vortex_record.load_record_access_facts_internal('update', locked_targets);
    for target_position in 1 .. pg_catalog.jsonb_array_length(loaded_set) loop
      locked_loaded[update_indexes[target_position] + 1] := loaded_set -> (target_position - 1);
    end loop;
    locked_memo := vortex_record.record_access_decision_memo_internal((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('owner', update_indexes[loaded.ordinality],
        'input', pg_catalog.jsonb_build_object(
          'declaration', loaded.value -> 'declaration',
          'recordId', locked_targets -> (loaded.ordinality - 1)::integer -> 'recordId',
          'facts', loaded.value -> 'facts')) order by loaded.ordinality)
      from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality)
      where loaded.value ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded.value -> 'declaration') = 'object'));
  end if;
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then continue; end if;
    prepared := coalesce(
      vortex_record.named_record_change_values_internal(p_named_roles, subject_index),
      vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid,
        type_contexts -> ((subject ->> 'recordTypeId') || ':' || (subject ->> 'operation')),
        locked_loaded[subject_index + 1], locked_memo -> (subject_index::text)
      )
    );
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('index', subject_index);
    end if;
    prepared_subjects := pg_catalog.array_append(prepared_subjects, prepared || pg_catalog.jsonb_build_object(
      'recordKey', 'intent:' || subject_index::text, 'index', subject_index
    ));
  end loop;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordKey', record.value -> 'recordKey', 'recordTypeId', root.value -> 'recordTypeId',
    'recordId', root.value -> 'recordId', 'values', (record.value -> 'existingValues') || (root.value -> 'values'),
    'lifecycleState', 'active'
  )), '[]'::jsonb) into proposals
  from pg_catalog.jsonb_array_elements(roots) as root(value)
  join pg_catalog.jsonb_array_elements(after_closure -> 'records') as record(value)
    on root.value -> 'recordKey' = record.value -> 'recordKey'
  where not exists (select 1 from pg_catalog.jsonb_array_elements(lifecycle -> 'proposals') as changed(value)
    where changed.value -> 'recordKey' = root.value -> 'recordKey');
  proposals := proposals || (lifecycle -> 'proposals');
  -- Restored records calculate from the recovered values, while their rule
  -- execution retains the stored deleted snapshot supplied in lifecycleChanges.
  select pg_catalog.jsonb_agg(case when changed.value ->> 'operation' = 'restore'
      then item.value || pg_catalog.jsonb_build_object('existingValues', changed.value -> 'proposedValues')
      else item.value end order by item.value ->> 'recordKey') into prepared
  from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
  left join pg_catalog.jsonb_array_elements(lifecycle -> 'changes') as changed(value)
    on changed.value -> 'recordKey' = item.value -> 'recordKey';
  graph := vortex_record.prepare_record_calculation_graph_internal(
    catalogue, coalesce(prepared, '[]'::jsonb), proposals, root_keys
  );
  if graph ->> 'outcome' is distinct from 'prepared' then return graph; end if;
  return graph || pg_catalog.jsonb_build_object(
    'records', (graph -> 'records') || projection_records,
    'subjects', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'index')::integer)
      from (select existing.value from pg_catalog.jsonb_array_elements(subjects) as existing(value)
        union all select added.value from pg_catalog.unnest(prepared_subjects) as added(value)) as item(value)),
    'lifecycleChanges', lifecycle -> 'changes', 'lifecycleProposals', lifecycle -> 'proposals',
    'correlationId', context_value -> 'correlationId',
    'preview', preview_installation is not null,
    'readableFieldIds', '[]'::jsonb,
    'recordCount', (after_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records)
  );
end
$function$;
alter function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb) is
  'Private record-set calculation preflight: authorizes roots (a named command''s subject and declared creates by its action) and lifecycle closures, locks their complete dependency union, repeats current authority and revisions, and returns one rule and total graph for all four intents.';

create or replace function vortex_record.propose_record_update_internal(
  p_command_id uuid,
  p_command_kind text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_activity_id uuid,
  p_action jsonb,
  p_meta jsonb,
  p_classification jsonb,
  p_loaded jsonb,
  p_targets jsonb,
  p_memo jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := p_command_kind;
  action_owner_kind text := p_action ->> 'ownerKind';
  action_owner_id uuid := (p_action ->> 'ownerId')::uuid;
  action_release_revision bigint := (p_action ->> 'releaseRevision')::bigint;
  action_id_value uuid := (p_action ->> 'actionId')::uuid;
  preview_installation jsonb := vortex_record.read_current_preview_installation_internal();
  effective_command_id uuid := p_command_id;
  organization_id_value uuid := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  application_root_id_value uuid := (vortex_access.validated_human_request_context() ->> 'applicationRootId')::uuid;
  meta jsonb := p_meta;
  loaded jsonb;
  decision jsonb;
  relationship_changes jsonb := p_classification -> 'relationshipChanges';
  final_values jsonb := p_final_values;
  relationship_change jsonb;
  update_bounds jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  activity_time timestamptz := pg_catalog.statement_timestamp();
begin
  if action_mode then
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
  else
    loaded := coalesce(p_loaded, (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', p_record_type_id, 'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number))) -> 0));
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (preview_installation is null
      and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is null then
    decision := vortex_record.decide_record_access_internal(
      p_memo, meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', meta -> 'declaration' -> 'recordBinding' )
    );
    if decision ->> 'outcome' = 'refused' then
      if action_mode then
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      else
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      end if;
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501',
        message = 'Record save authority is unavailable';
    end if;
    update_bounds := vortex_record.remembered_record_field_bounds_internal(p_memo, decision, 'resolved');
  else
    update_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if update_bounds is null then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  end if;
  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        update_bounds -> 'changeableFieldIds'
      ) as allowed(value)
      where pg_catalog.lower(allowed.value) =
        pg_catalog.lower(relationship_change ->> 'fieldId')
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Build the complete proposed source facts before the first mutation. A
  -- changed fixed relationship replaces its old edge; the exact validated
  -- target's private facts are loaded only inside this operation and are
  -- never returned. The same current update declaration must still allow the
  -- source under the complete proposed values and graph.
  proposed_records := loaded -> 'facts' -> 'records';
  proposed_edges := loaded -> 'facts' -> 'edges';

  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
      target := vortex_record.relationship_change_target_internal(relationship_change);
      if target is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      target_record_type_id := (target ->> 'recordTypeId')::uuid;
      target_record_id := (target ->> 'recordId')::uuid;

      -- The set loaded every exact target once, before any record was prepared.
      target_loaded := p_targets -> (pg_catalog.lower(target_record_type_id::text) || ':' || pg_catalog.lower(target_record_id::text));
      if target_loaded is null then
        raise exception using errcode = '55000', message = 'Relationship target facts were not loaded';
      end if;
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      -- Only a record of this application's own Module uses preview-owner authority.
      -- Borrowed records and live projections still need the builder's current permission.
      if preview_installation is not null
        and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
        and exists (
          select 1 from vortex_definition.roots as root
          where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
            and root.owner_application_root_id = application_root_id_value
        ) then
        target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
      else
        if pg_catalog.jsonb_array_length(
          target_loaded #> '{declaration,requiredPermissions}'
        ) = 0 then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_record.decide_record_access_internal(
          p_memo, pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb),
          target_record_id, target_loaded -> 'facts'
        );
      end if;
      if target_decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;

      proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
      proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
    end if;
  end loop;

  -- The one canonical lock prelude: every changed link's target row is
  -- share-locked in relationship identity order here, after each target has
  -- passed the same access decision the writer re-checks and before any
  -- source data version or relationship edge identity is taken. Keeping all
  -- target row locks in one place means no writer orders them on its own.
  perform vortex_record.lock_record_change_targets_internal(
    meta -> 'recordType', organization_id_value, final_values
  );

  proposed_facts := vortex_record.proposed_update_facts_internal(
    loaded, p_record_id, final_values, relationship_changes, proposed_records, proposed_edges
  );
  -- The proposal is everything the proposed-state decision and the write need; the set decides
  -- every proposal together before any is written.
  return pg_catalog.jsonb_build_object(
    'outcome', 'proposed', 'loaded', loaded, 'classification', p_classification,
    'proposedFacts', proposed_facts,
    'changeFacts', case when action_mode then null else
      vortex_record.proposed_change_facts_internal(
        loaded, p_record_id, p_classification -> 'valueFinalValues') -> 'facts' end
  );
end
$function$;
alter function vortex_record.propose_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.propose_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.propose_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) is
  'Private first stage of common update preparation for ordinary and named-action records: loads the current revision, checks current authority and field bounds, loads and checks relationship targets from the set-wide target facts, takes the relationship target row locks, and returns the complete proposed source facts for the proposed-state decision.';

create or replace function vortex_record.prepare_record_update_internal(
  p_command_id uuid,
  p_command_kind text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_activity_id uuid,
  p_action jsonb,
  p_meta jsonb,
  p_proposal jsonb,
  p_memo jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := p_command_kind;
  action_owner_kind text := p_action ->> 'ownerKind';
  action_owner_id uuid := (p_action ->> 'ownerId')::uuid;
  action_release_revision bigint := (p_action ->> 'releaseRevision')::bigint;
  action_id_value uuid := (p_action ->> 'actionId')::uuid;
  preview_installation jsonb := vortex_record.read_current_preview_installation_internal();
  effective_command_id uuid := p_command_id;
  organization_id_value uuid := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  application_root_id_value uuid := (vortex_access.validated_human_request_context() ->> 'applicationRootId')::uuid;
  meta jsonb := p_meta;
  loaded jsonb := p_proposal -> 'loaded';
  proposed_facts jsonb := p_proposal -> 'proposedFacts';
  relationship_changes jsonb := p_proposal -> 'classification' -> 'relationshipChanges';
  value_final_values jsonb := p_proposal -> 'classification' -> 'valueFinalValues';
  final_values jsonb := p_final_values;
  decision jsonb;
  mutation jsonb;
  relationship_change jsonb;
  storage_change jsonb;
  prepared_relationship jsonb;
  prepared_relationships jsonb;
  value_submitted_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
begin
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(p_proposal -> 'classification' -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if preview_installation is null then
    decision := vortex_record.decide_record_access_internal(p_memo, loaded -> 'declaration', p_record_id, proposed_facts);
    if decision ->> 'outcome' <> 'allowed' then
      if action_mode then
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      else
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      end if;
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
      );
    end if;
  end if;
  if final_values = '{}'::jsonb then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'empty_base_update'
    );
  end if;
  if action_mode then
    mutation := vortex_record.prepare_named_action_record_change_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number,
      value_final_values, value_submitted_field_ids,
      action_owner_kind, action_owner_id, action_release_revision, action_id_value
    );
  else
    mutation := vortex_record.prepare_record_change_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number,
      value_final_values, value_submitted_field_ids, loaded, p_memo
    );
  end if;

  if mutation ->> 'outcome' = 'allowed' then
    storage_change := mutation -> 'storageChange';
    prepared_relationships := '[]'::jsonb;
    if preview_installation is null and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      perform vortex_record.bump_record_data_version_internal(
        organization_id_value, (meta ->> 'storageContractId')::uuid,
        case when meta ->> 'storageScope' = 'application_contained'
          then application_root_id_value else null end
      );
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      prepared_relationship := vortex_record.prepare_relationship_value_internal(
        p_record_type_id, p_record_id,
        (relationship_change ->> 'relationshipId')::uuid,
        relationship_change -> 'value', false
      );
      storage_change := pg_catalog.jsonb_set(storage_change, '{values}',
        (storage_change -> 'values') || pg_catalog.jsonb_build_object(
          prepared_relationship ->> 'column', prepared_relationship -> 'value'
        )
      );
      prepared_relationships := prepared_relationships ||
        pg_catalog.jsonb_build_array(prepared_relationship);
    end loop;
    mutation := mutation || pg_catalog.jsonb_build_object(
      'storageChange', storage_change, 'edgeChanges', prepared_relationships
    );
  end if;
  return mutation;
end
$function$;
alter function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb,jsonb,jsonb) is
  'Private second stage of common update preparation for ordinary and named-action records: checks the proposed-state authority the set decided for the proposal, and returns one combined scalar/link storage mutation and its edges.';

create or replace function vortex_record.prepare_record_change_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_loaded jsonb default null,
  p_memo jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed jsonb;
  proposed_facts jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  physical_values jsonb := '{}'::jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := coalesce(p_loaded, (vortex_record.load_record_access_facts_internal(
    'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number
    ))
  ) -> 0));
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := vortex_record.decide_record_access_internal(
      p_memo, loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_record.remembered_record_field_bounds_internal(p_memo, decision, 'decided');
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    physical_values := physical_values || pg_catalog.jsonb_build_object(
      column_entry ->> 'token', entry_value
    );
  end loop;

  proposed := vortex_record.proposed_change_facts_internal(loaded, p_record_id, p_final_values);
  proposed_values := proposed -> 'values';
  proposed_facts := proposed -> 'facts';

  if not (loaded ? 'previewInstallationId') then
    decision := vortex_record.decide_record_access_internal(
      p_memo, loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_record.remembered_record_field_bounds_internal(p_memo, decision, 'decided');
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'values', values_value,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', loaded #> '{recordTypeMeta,storageContractId}',
      'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object(
        'definition_revision', loaded -> 'moduleReleaseRevision'
      )
    )
  );
end
$function$;
alter function vortex_record.prepare_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],jsonb,jsonb) owner to vortex_record_adapter;


alter function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[], jsonb, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[], jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[], jsonb, jsonb) is
  'Private record update preparation. Locks the current revision, checks current and proposed authority and field bounds, and returns the storage mutation and permitted projection for the set writer.';

create or replace function vortex_record.decide_record_access_internal(
  p_memo jsonb,
  p_declaration jsonb,
  p_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  input_value jsonb := pg_catalog.jsonb_build_object(
    'declaration', p_declaration, 'recordId', p_record_id, 'facts', p_facts
  );
  input_digest text;
  remembered jsonb;
begin
  -- A decision the whole set already made for this exact input (found by the digest of its text)
  -- is reused; any other input is decided now, so a memo never answers for a different
  -- declaration, record or facts.
  if p_memo is not null then
    input_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(input_value::text, 'UTF8')), 'hex');
    select entry.value -> 'decision' into remembered
    from pg_catalog.jsonb_array_elements(p_memo -> 'decisions') as entry(value)
    where entry.value ->> 'digest' = input_digest
    limit 1;
    if remembered is not null then return remembered; end if;
  end if;
  return (vortex_access.evaluate_organization_record_access_internal(
    pg_catalog.jsonb_build_array(input_value)
  ) -> 0);
end
$function$;
alter function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb) is
  'Private record access decision for one input that reuses the decision a set preparation already made for the identical declaration, record and facts, and otherwise evaluates it.';

create or replace function vortex_record.prepare_record_change_set_internal(
  p_command_id uuid,
  p_subjects jsonb,
  p_named_roles jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subject jsonb;
  ordinal integer;
  meta jsonb;
  meta_cache jsonb := '{}'::jsonb;
  cache_key text;
  prepared jsonb;
  receipt vortex_record.command_receipts%rowtype;
  plans jsonb[] := array[]::jsonb[];
  storage_changes jsonb := '[]'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  effects jsonb := '[]'::jsonb;
  restore_subject jsonb;
  submitted_fields uuid[];
  normalized_edges jsonb;
  named_role jsonb;
  named_action jsonb;
  preview_installation jsonb;
  context_value jsonb;
  update_targets jsonb := '[]'::jsonb;
  load_ordinals integer[] := array[]::integer[];
  update_loaded jsonb[] := array[]::jsonb[];
  update_classifications jsonb := '{}'::jsonb;
  update_proposals jsonb[] := array[]::jsonb[];
  update_memo jsonb := '{}'::jsonb;
  loaded_set jsonb;
  classification jsonb;
  proposal jsonb;
  link_targets jsonb;
  link_batch jsonb;
  loaded_targets jsonb;
  target_facts jsonb := '{}'::jsonb;
  decision_entries jsonb;
  batch_start integer;
  target_position integer;
  update_meta jsonb;
begin
  if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  receipt := vortex_record.lock_command_receipt_internal('record_changes', p_command_id);
  if receipt.command_id is null or receipt.result is not null then
    raise exception using errcode = '42501', message = 'Record set receipt is unavailable';
  end if;

  -- Every update of the set is prepared in two stages with the set-wide work between them, never
  -- one record at a time, all in the stable lock order: the updates are classified, the plain ones
  -- load their current facts together and every link target is loaded once; the current authority
  -- of every update is decided together; each update then proposes its complete facts; the
  -- proposed-state authority of every proposal is decided together; each update is then prepared
  -- from its proposal. A single update is a set of one.
  preview_installation := vortex_record.read_current_preview_installation_internal();
  for subject, ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordTypeId')::uuid,
      (item.value ->> 'recordId')::uuid nulls last, item.ordinality
  loop
    if subject ->> 'operation' <> 'update' then
      continue;
    end if;
    named_role := p_named_roles #> array['roles', ordinal::text];
    named_action := case when named_role ->> 'role' = 'subject'
      then p_named_roles #> array['subjects', named_role ->> 'named', 'action'] end;
    if named_action is not null then
      update_meta := p_named_roles -> 'actionContext';
    else
      cache_key := (subject ->> 'recordTypeId') || ':update';
      if not meta_cache ? cache_key then
        meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
          vortex_record.resolve_record_action_context_internal((subject ->> 'recordTypeId')::uuid, 'update'));
      end if;
      update_meta := meta_cache -> cache_key;
    end if;
    -- A subject the preparation below refuses, or a settings record, is not prepared here.
    if pg_catalog.jsonb_typeof(update_meta -> 'recordType') is distinct from 'object'
      or update_meta -> 'recordType' ? 'systemProjection'
      or (coalesce(named_role ->> 'role', 'copy') = 'copy'
        and not coalesce((update_meta #> '{recordType,standardActions}') ? 'update', false)) then
      continue;
    end if;
    classification := vortex_record.classify_record_change_values_internal(
      (subject ->> 'recordTypeId')::uuid, subject -> 'finalValues', update_meta, subject -> 'submittedValues',
      (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
      'record_changes', p_command_id
    );
    if classification ->> 'outcome' is distinct from 'classified' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'subject', classification);
    end if;
    update_classifications := update_classifications || pg_catalog.jsonb_build_object(ordinal::text, classification);
    if named_role is null and preview_installation is null then
      update_targets := update_targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', (subject ->> 'recordTypeId')::uuid, 'recordId', (subject ->> 'recordId')::uuid,
        'expectedConcurrencyNumber', (subject ->> 'expectedConcurrencyNumber')::bigint
      ));
      load_ordinals := pg_catalog.array_append(load_ordinals, ordinal);
    end if;
  end loop;
  if pg_catalog.cardinality(load_ordinals) > 0 then
    loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
    for target_position in 1 .. pg_catalog.cardinality(load_ordinals) loop
      update_loaded[load_ordinals[target_position] + 1] := loaded_set -> (target_position - 1);
    end loop;
  end if;
  -- Every link target of the set is loaded once, not once per record that names it.
  select coalesce(pg_catalog.jsonb_agg(distinct requested.target), '[]'::jsonb) into link_targets
  from (
    select vortex_record.relationship_change_target_internal(change.value) as target
    from pg_catalog.jsonb_each(update_classifications) as classified(ordinal, value)
    cross join lateral pg_catalog.jsonb_array_elements(classified.value -> 'relationshipChanges') as change(value)
    where pg_catalog.jsonb_typeof(change.value -> 'value') <> 'null'
  ) as requested
  where requested.target is not null;
  for batch_start in 0 .. pg_catalog.jsonb_array_length(link_targets) - 1 by 200 loop
    select pg_catalog.jsonb_agg(item.value order by item.ordinality) into link_batch
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality as item(value, ordinality)
    where item.ordinality > batch_start and item.ordinality <= batch_start + 200;
    loaded_targets := vortex_record.load_record_access_facts_internal('read', link_batch);
    target_facts := target_facts || (
      select pg_catalog.jsonb_object_agg(
        pg_catalog.lower(requested.value ->> 'recordTypeId') || ':' || pg_catalog.lower(requested.value ->> 'recordId'),
        facts.value)
      from pg_catalog.jsonb_array_elements(link_batch) with ordinality as requested(value, ordinality)
      join pg_catalog.jsonb_array_elements(loaded_targets) with ordinality as facts(value, ordinality)
        on facts.ordinality = requested.ordinality);
  end loop;
  -- The current authority of every plain update (twice: as the action declares it and as the
  -- record's own declaration says) and of every link target, decided together.
  if preview_installation is null then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('owner', entry.owner, 'input', entry.input)
      order by entry.owner, entry.kind)
    into decision_entries
    from (
      select plain.ordinal as owner, 1 as kind,
        pg_catalog.jsonb_build_object('declaration', meta_cache -> ((p_subjects -> plain.ordinal ->> 'recordTypeId') || ':update') -> 'declaration',
          'recordId', (p_subjects -> plain.ordinal ->> 'recordId')::uuid,
          'facts', (item.value -> 'facts') || pg_catalog.jsonb_build_object('binding',
            meta_cache -> ((p_subjects -> plain.ordinal ->> 'recordTypeId') || ':update') -> 'declaration' -> 'recordBinding')) as input
      from pg_catalog.unnest(load_ordinals) with ordinality as plain(ordinal, position)
      join pg_catalog.jsonb_array_elements(loaded_set) with ordinality as item(value, position)
        on item.position = plain.position
      where item.value ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(item.value -> 'declaration') = 'object'
      union all
      select plain.ordinal, 2,
        pg_catalog.jsonb_build_object('declaration', item.value -> 'declaration',
          'recordId', (p_subjects -> plain.ordinal ->> 'recordId')::uuid, 'facts', item.value -> 'facts')
      from pg_catalog.unnest(load_ordinals) with ordinality as plain(ordinal, position)
      join pg_catalog.jsonb_array_elements(loaded_set) with ordinality as item(value, position)
        on item.position = plain.position
      where item.value ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(item.value -> 'declaration') = 'object'
      union all
      select classified.ordinal::integer, 5,
        pg_catalog.jsonb_build_object(
          'declaration', pg_catalog.jsonb_set(facts.value -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb),
          'recordId', (target.value ->> 'recordId')::uuid, 'facts', facts.value -> 'facts')
      from pg_catalog.jsonb_each(update_classifications) as classified(ordinal, value)
      cross join lateral pg_catalog.jsonb_array_elements(classified.value -> 'relationshipChanges') as change(value)
      cross join lateral (select vortex_record.relationship_change_target_internal(change.value)) as target(value)
      join lateral (select target_facts -> (pg_catalog.lower(target.value ->> 'recordTypeId') || ':' || pg_catalog.lower(target.value ->> 'recordId'))) as facts(value) on true
      where pg_catalog.jsonb_typeof(change.value -> 'value') <> 'null'
        and target.value is not null
        and facts.value ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(facts.value -> 'declaration') = 'object'
        and pg_catalog.jsonb_array_length(facts.value #> '{declaration,requiredPermissions}') > 0
    ) as entry;
    update_memo := vortex_record.record_access_decision_memo_internal(decision_entries);
  end if;
  -- Stage one: each update proposes its complete facts.
  for subject, ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordTypeId')::uuid,
      (item.value ->> 'recordId')::uuid nulls last, item.ordinality
  loop
    if not update_classifications ? ordinal::text then
      continue;
    end if;
    named_role := p_named_roles #> array['roles', ordinal::text];
    named_action := case when named_role ->> 'role' = 'subject'
      then p_named_roles #> array['subjects', named_role ->> 'named', 'action'] end;
    proposal := vortex_record.propose_record_update_internal(
      p_command_id, 'record_changes', (subject ->> 'recordTypeId')::uuid,
      (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
      subject -> 'finalValues', (subject ->> 'activityId')::uuid, named_action,
      case when named_action is not null then p_named_roles -> 'actionContext'
        else meta_cache -> ((subject ->> 'recordTypeId') || ':update') end,
      update_classifications -> ordinal::text, update_loaded[ordinal + 1], target_facts,
      update_memo -> ordinal::text
    );
    if proposal ->> 'outcome' is distinct from 'proposed' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'subject', proposal);
    end if;
    update_proposals[ordinal + 1] := proposal;
  end loop;
  -- The proposed-state authority of every proposal, decided together: once on the proposed
  -- facts of the update and once on the proposed facts of the record's own change.
  if preview_installation is null then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('owner', entry.owner, 'input', entry.input)
      order by entry.owner, entry.kind)
    into decision_entries
    from (
      select (proposed.position - 1)::integer as owner, 3 as kind,
        pg_catalog.jsonb_build_object('declaration', proposed.value -> 'loaded' -> 'declaration',
          'recordId', (p_subjects -> (proposed.position - 1)::integer ->> 'recordId')::uuid,
          'facts', proposed.value -> 'proposedFacts') as input
      from pg_catalog.unnest(update_proposals) with ordinality as proposed(value, position)
      where proposed.value is not null
      union all
      select (proposed.position - 1)::integer, 4,
        pg_catalog.jsonb_build_object('declaration', proposed.value -> 'loaded' -> 'declaration',
          'recordId', (p_subjects -> (proposed.position - 1)::integer ->> 'recordId')::uuid,
          'facts', proposed.value -> 'changeFacts')
      from pg_catalog.unnest(update_proposals) with ordinality as proposed(value, position)
      where pg_catalog.jsonb_typeof(proposed.value -> 'changeFacts') = 'object'
    ) as entry;
    update_memo := vortex_record.record_access_decision_memo_internal(decision_entries, update_memo);
  end if;

  -- Existing row locks are acquired in stable record-type/record identity order.
  -- Creation identities are allocated by the private create preparation itself.
  for subject, ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordTypeId')::uuid,
      (item.value ->> 'recordId')::uuid nulls last, item.ordinality
  loop
    named_role := p_named_roles #> array['roles', ordinal::text];
    named_action := case when named_role ->> 'role' = 'subject'
      then p_named_roles #> array['subjects', named_role ->> 'named', 'action'] end;
    -- A named subject write is prepared under its action; a declared create needs
    -- no standard create, since the installed action declares it.
    if named_action is not null and subject ->> 'operation' = 'update' then
      meta := p_named_roles -> 'actionContext';
    else
      cache_key := (subject ->> 'recordTypeId') || ':' || (subject ->> 'operation');
      if not meta_cache ? cache_key then
        meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
          vortex_record.resolve_record_action_context_internal(
            (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
          ));
      end if;
      meta := meta_cache -> cache_key;
    end if;
    if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or (subject ->> 'operation' in ('create', 'update')
        and coalesce(named_role ->> 'role', 'copy') = 'copy'
        and not coalesce((meta #> '{recordType,standardActions}') ? (subject ->> 'operation'), false)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'index', ordinal, 'reasonCode', 'record_unavailable'
      );
    end if;
    if meta -> 'recordType' ? 'systemProjection' then
      if subject ->> 'operation' <> 'update' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'reasonCode', 'record_unavailable');
      end if;
      prepared := vortex_record.prepare_settings_record_change_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues', subject -> 'finalValues'
      );
      if prepared ->> 'outcome' = 'prepared' and prepared -> 'currentConcurrencyNumber'
        is distinct from subject -> 'expectedConcurrencyNumber' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict', 'index', ordinal, 'reasonCode', 'record_revision_conflict');
      end if;
    elsif subject ->> 'operation' = 'create' then
      prepared := vortex_record.classify_record_change_values_internal(
        (subject ->> 'recordTypeId')::uuid, subject -> 'finalValues', meta, subject -> 'submittedValues',
        (meta #>> '{context,organizationId}')::uuid, (meta #>> '{context,applicationRootId}')::uuid,
        'record_changes', p_command_id
      );
      if prepared ->> 'outcome' is distinct from 'classified' then
        return prepared || pg_catalog.jsonb_build_object('index', ordinal);
      end if;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as key;
      prepared := vortex_record.prepare_record_create_internal(
        (subject ->> 'recordTypeId')::uuid, subject -> 'finalValues', submitted_fields,
        (subject ->> 'selectedGroupId')::uuid
      );
      if prepared ->> 'outcome' = 'prepared' then
        storage_changes := storage_changes || pg_catalog.jsonb_build_array(prepared -> 'storageChange');
        edge_changes := edge_changes || (prepared -> 'edgeChanges');
      end if;
    elsif subject ->> 'operation' = 'update' then
      if update_proposals[ordinal + 1] is null then
        raise exception using errcode = '55000', message = 'Record update proposal is unavailable';
      end if;
      prepared := vortex_record.prepare_record_update_internal(
        p_command_id, 'record_changes', (subject ->> 'recordTypeId')::uuid,
        (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
        subject -> 'finalValues', (subject ->> 'activityId')::uuid,
        named_action, meta, update_proposals[ordinal + 1], update_memo -> (ordinal::text)
      );
      if prepared ->> 'outcome' = 'allowed' then
        storage_changes := storage_changes || pg_catalog.jsonb_build_array(prepared -> 'storageChange');
        edge_changes := edge_changes || (prepared -> 'edgeChanges');
      end if;
    elsif subject ->> 'operation' = 'delete' then
      prepared := vortex_record.prepare_record_delete_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, array[]::text[]
      );
      storage_changes := storage_changes || (prepared -> 'storageChanges');
      edge_changes := edge_changes || (prepared -> 'edgeChanges');
      effects := effects || (prepared -> 'effects');
      prepared := prepared || pg_catalog.jsonb_build_object('outcome', 'prepared');
    else
      prepared := vortex_record.prepare_record_restore_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint
      );
      if prepared ->> 'outcome' = 'prepared' then
        storage_changes := storage_changes || (prepared -> 'storageChanges');
        for restore_subject in
          select item.value from pg_catalog.jsonb_array_elements(prepared -> 'subjects') as item(value)
        loop
          effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'effectKind', case when (restore_subject ->> 'deleted')::boolean then 'restored' else 'links_restored' end,
            'storageContractId', restore_subject -> 'storageContractId',
            'recordTypeId', restore_subject -> 'recordTypeId', 'recordId', restore_subject -> 'recordId',
            'preConcurrencyNumber', restore_subject -> 'expectedConcurrencyNumber',
            'relationshipId', null, 'previousValue', null,
            'restoresCommandId', prepared -> 'deleteCommandId',
            'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId'
            ))
          ));
        end loop;
      end if;
    end if;
    if not coalesce(prepared ->> 'outcome' in ('allowed', 'prepared'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'subject', prepared);
    end if;
    plans := pg_catalog.array_append(plans, pg_catalog.jsonb_build_object(
      'index', ordinal, 'subject', subject, 'meta', meta, 'prepared', prepared,
      'action', named_action, 'role', named_role -> 'role'
    ));
  end loop;

  -- Overlapping delete closures can repeat the same field delta. Conflicting
  -- explicit intentions are refused before any physical record is written.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
    cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
    group by item.value -> 'storageContractId', item.value -> 'recordId', field.key
    having pg_catalog.count(distinct field.value) > 1
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      item.value -> 'targetStorageContractId', item.value -> 'targetRecordId'
    )) > 1
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
  end if;
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.value ->> 'relationshipId',
    candidate.value ->> 'sourceStorageContractId', candidate.value ->> 'sourceRecordId'), '[]'::jsonb)
  into normalized_edges
  from (
    select distinct on (item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId')
      item.value
    from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    order by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
  ) as candidate;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'plans', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'index')::integer)
      from pg_catalog.unnest(plans) as item(value)),
    'storageChanges', vortex_record.combine_record_storage_changes_internal(storage_changes),
    'edgeChanges', normalized_edges, 'effects', effects
  );
end
$function$;
alter function vortex_record.prepare_record_change_set_internal(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_change_set_internal(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_change_set_internal(uuid,jsonb,jsonb) is
  'Private closed preparation of up to 200 record intents under one claimed set receipt; reuses create, update (ordinary or under a named action) and lifecycle authority checks, gathers closure effects, and combines compatible deltas for one physical write per storage table.';

reset role;
