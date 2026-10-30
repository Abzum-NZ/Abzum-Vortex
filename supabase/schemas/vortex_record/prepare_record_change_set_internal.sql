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
