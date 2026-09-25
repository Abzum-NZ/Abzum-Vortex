-- #992: rebaseline the record read and save functions.
--
-- These functions' live bodies existed only as chains of in-place text patches.
-- Each is re-created here in full, with unchanged signatures, owner, grants,
-- comments, security, search_path and behaviour. Nothing is patched or read back.
-- Each statement is identical to the canonical file
-- supabase/schemas/vortex_record/<function>.sql changed in this commit.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.save_base_record(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  command_fingerprint_value text;
  inserted_command_id uuid;
  receipt vortex_record.save_command_receipts%rowtype;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;

  command_fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_selected_group_id
  );

  insert into vortex_record.save_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, command_fingerprint, record_type_id, operation, state
  ) values (
    organization_id_value, application_root_id_value, actor_id_value,
    p_command_id, command_fingerprint_value, p_record_type_id, p_operation,
    'pending'
  )
  on conflict do nothing
  returning command_id into inserted_command_id;

  if inserted_command_id is null then
    select stored.* into strict receipt
    from vortex_record.save_command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_id = p_command_id
    for update;
    if receipt.command_fingerprint is distinct from command_fingerprint_value
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.operation is distinct from p_operation then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt.state is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    projection := vortex_record.read_record(p_record_type_id, receipt.record_id);
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', 'pending',
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    delete from vortex_record.save_command_receipts
    where organization_id = organization_id_value
      and application_root_id = application_root_id_value
      and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        delete from vortex_record.save_command_receipts
        where organization_id = organization_id_value
          and application_root_id = application_root_id_value
          and actor_organization_account_id = actor_id_value
          and command_id = p_command_id;
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' = 'refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501',
        message = 'Record save authority is unavailable';
    end if;
    update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
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
        delete from vortex_record.save_command_receipts
        where organization_id = organization_id_value
          and application_root_id = application_root_id_value
          and actor_organization_account_id = actor_id_value
          and command_id = p_command_id;
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
    proposed_field_values := (loaded -> 'fieldValues') || p_final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          delete from vortex_record.save_command_receipts
          where organization_id = organization_id_value
            and application_root_id = application_root_id_value
            and actor_organization_account_id = actor_id_value
            and command_id = p_command_id;
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          delete from vortex_record.save_command_receipts
          where organization_id = organization_id_value
            and application_root_id = application_root_id_value
            and actor_organization_account_id = actor_id_value
            and command_id = p_command_id;
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          delete from vortex_record.save_command_receipts
          where organization_id = organization_id_value
            and application_root_id = application_root_id_value
            and actor_organization_account_id = actor_id_value
            and command_id = p_command_id;
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
        );
        if target_decision ->> 'outcome' <> 'allowed' then
          delete from vortex_record.save_command_receipts
          where organization_id = organization_id_value
            and application_root_id = application_root_id_value
            and actor_organization_account_id = actor_id_value
            and command_id = p_command_id;
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        -- #858: take this target row lock here, before the writer loop below
        -- takes any edge identity, so a later iteration never locks a target
        -- row after an earlier iteration already holds an edge identity.
        perform vortex_record.lock_relationship_target_row_internal(
          target_record_type_id, target_record_id, organization_id_value
        );
        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

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
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
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
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
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
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
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

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
      );
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, p_final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if p_final_values = '{}'::jsonb then
      delete from vortex_record.save_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    delete from vortex_record.save_command_receipts
    where organization_id = organization_id_value
      and application_root_id = application_root_id_value
      and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else p_final_values end
  ) as key;

  activity_time := vortex_record.append_base_save_activity_internal(
    p_activity_id, p_operation, saved_record_id,
    changed_field_ids, 'completed'
  );

  event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
  event_payload := case when p_operation = 'create'
    then pg_catalog.jsonb_build_object('kind', 'created')
    else pg_catalog.jsonb_build_object(
      'kind', 'changed',
      'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
    ) end;
  event_result := vortex_event.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    saved_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', event_kind,
        'recordTypeId', p_record_type_id
      ),
      'payload', event_payload
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Record save Event append failed';
  end if;

  update vortex_record.save_command_receipts as stored
  set state = 'completed', record_id = saved_record_id,
    concurrency_number = saved_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = organization_id_value
    and stored.application_root_id = application_root_id_value
    and stored.actor_organization_account_id = actor_id_value
    and stored.command_id = p_command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = 'Record save receipt is stale';
  end if;

  projection := vortex_record.read_record(p_record_type_id, saved_record_id);
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved Record projection is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
end
$function$;

alter function vortex_record.save_base_record(uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.save_base_record(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
revoke execute on function vortex_record.save_base_record(uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid)
from vortex_runtime;

comment on function vortex_record.save_base_record(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid
) is
  'The one fixed base human Record save: rechecks authority and atomically writes Record, Activity, Event/queue and receipt.';

create or replace function vortex_record.save_base_record_with_relationship_totals(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  preparation_value jsonb;
  reduced_final_values jsonb;
  context_value jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  relationship_value jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  expected_parents jsonb;
  supplied_parents jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Receipt identity remains authoritative for replay and changed-input
  -- duplicate classification. A completed command must reach that owner even
  -- if a caller supplies no longer-current relationship mutations.
  if not exists (
    select 1 from vortex_record.save_command_receipts receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
    -- The writer repeats the protected preparation itself.  Closure identity,
    -- revisions and the complete generated-field set therefore never depend
    -- on caller-controlled transaction state or a replayable preparation token.
    preparation_value := vortex_record.prepare_relationship_total_save(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_selected_group_id,
      p_activity_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' = 'defer' and exists (
      select 1 from vortex_record.save_command_receipts receipt
      where receipt.organization_id = (context_value ->> 'organizationId')::uuid
        and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and receipt.actor_organization_account_id =
          (context_value ->> 'organizationAccountId')::uuid
        and receipt.command_id = p_command_id
    ) then
      preparation_value := null;
    elsif preparation_value ->> 'outcome' = 'defer' then
      catalogue := vortex_record.relationship_total_catalogue_internal();
      if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
        closure_value := vortex_record.discover_relationship_total_closure_internal(
          catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
        );
        select item.value into root_type
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') =
          pg_catalog.lower(p_record_type_id::text);
        select item.value into root_snapshot
        from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if root_type is null or root_snapshot is null then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
        for relationship_value, target_type in
          select item.value, target.value
          from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
          join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
            on vortex_record.relationship_declares_target_internal(
              item.value, (target.value ->> 'recordTypeId')::uuid
            )
          where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
          order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
        loop
          relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
          old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
          proposed_relationship_target := old_relationship_target;
          if p_submitted_values ? relationship_field_id then
            proposed_relationship_target := p_submitted_values -> relationship_field_id;
          end if;
          if not (
            (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
              pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
            or
            (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
              pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
          ) then
            continue;
          end if;
          for total_field in
            select field.value
            from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
            where field.value ->> 'type' = 'total'
              and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                pg_catalog.lower(relationship_value ->> 'relationshipId')
          loop
            if p_submitted_values ? relationship_field_id and
              p_submitted_values -> relationship_field_id is distinct from
                coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
              contributes_to_total := true;
              exit;
            end if;
            dependency_contract := vortex_record.total_dependency_contract_internal(
              catalogue -> 'recordTypes',
              pg_catalog.jsonb_build_array(relationship_value),
              (target_type ->> 'recordTypeId')::uuid, total_field
            );
            for dependency_field_id in
              select item.value
              from pg_catalog.jsonb_array_elements_text(
                dependency_contract -> 'sourceFieldIds'
              ) item(value)
            loop
              if p_final_values ? dependency_field_id and
                p_final_values -> dependency_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
            end loop;
            exit when contributes_to_total;
          end loop;
          exit when contributes_to_total;
        end loop;
        if contributes_to_total then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;
    if preparation_value ->> 'outcome' <> 'prepared' then
      if pg_catalog.jsonb_array_length(p_parent_mutations) = 0 then
        preparation_value := null;
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    else
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.lower(field.value ->> 'fieldId')
              order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
            )
            from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
            where field.value ->> 'type' in ('total', 'calculation')
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into expected_parents
      from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
      where item.value ->> 'recordKey' <> 'root';
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
            from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into supplied_parents
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) = 'object'
        and item.value ?& array[
          'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
        ]
        and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
      if supplied_parents is distinct from expected_parents
        or pg_catalog.jsonb_array_length(supplied_parents) <>
          pg_catalog.jsonb_array_length(p_parent_mutations) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    end if;
  end if;
  result_value := vortex_record.save_base_record(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_final_values,
    p_selected_group_id, p_activity_id, p_occurrence_id
  );
  if result_value ->> 'outcome' <> 'saved' or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;
  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023', message = 'Relationship total parent mutation is incomplete';
    end if;
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;
  return result_value;
end
$function$;

alter function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) owner to vortex_record_adapter;


revoke all on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
to vortex_runtime;
comment on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) is
  'Existing protected base save composed with revision-checked generated parent totals, Activity and standard Events in the same transaction.';

create or replace function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb,
  p_due_transition jsonb,
  p_parent_due_transitions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  context_value jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  transition_field_id uuid;
  transition_at_value timestamptz;
  metadata_application_root_id uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
begin
  if not vortex_record.parent_deadline_due_transitions_are_valid_internal(
    p_parent_mutations, p_parent_due_transitions
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  if p_due_transition is not null then
    if pg_catalog.jsonb_typeof(p_due_transition) <> 'object'
      or p_due_transition - array['calculationFieldId', 'transitionAt'] <> '{}'::jsonb
      or not (p_due_transition ?& array['calculationFieldId', 'transitionAt'])
      or pg_catalog.jsonb_typeof(p_due_transition -> 'calculationFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(p_due_transition -> 'transitionAt') <> 'string'
      or not pg_catalog.pg_input_is_valid(
        p_due_transition ->> 'calculationFieldId', 'uuid'
      )
      or (p_due_transition ->> 'calculationFieldId')::uuid =
        '00000000-0000-0000-0000-000000000000'::uuid
      or not (p_due_transition ->> 'transitionAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      or not pg_catalog.pg_input_is_valid(
        p_due_transition ->> 'transitionAt', 'timestamp with time zone'
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    transition_field_id := (p_due_transition ->> 'calculationFieldId')::uuid;
    transition_at_value := (p_due_transition ->> 'transitionAt')::timestamptz;
  end if;

  result_value := vortex_record.save_base_record_with_relationship_totals(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_final_values,
    p_selected_group_id, p_activity_id, p_occurrence_id, p_parent_mutations
  );
  if result_value ->> 'outcome' <> 'saved'
    or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record deadline metadata requires an Application context';
  end if;
  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id;
  metadata_application_root_id := case storage_row.storage_scope
    when 'application_contained' then (context_value ->> 'applicationRootId')::uuid
    else null
  end;

  saved_record_id := (result_value ->> 'recordId')::uuid;
  saved_concurrency_number := (result_value ->> 'concurrencyNumber')::bigint;
  if p_due_transition is null then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = (context_value ->> 'organizationId')::uuid
      and metadata.storage_contract_id = storage_row.storage_contract_id
      and metadata.record_id = saved_record_id
      and metadata.application_root_id is not distinct from metadata_application_root_id;
  else
    insert into vortex_record.record_deadline_due_metadata (
      organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
      application_root_id, record_concurrency_number,
      deadline_calculation_field_id, transition_at
    ) values (
      (context_value ->> 'organizationId')::uuid,
      storage_row.storage_contract_id,
      storage_row.storage_scope,
      saved_record_id,
      p_record_type_id,
      metadata_application_root_id,
      saved_concurrency_number,
      transition_field_id,
      transition_at_value
    ) on conflict (
      organization_id, storage_contract_id, record_id, application_root_id
    )
    do update set
      storage_scope = excluded.storage_scope,
      record_type_id = excluded.record_type_id,
      record_concurrency_number = excluded.record_concurrency_number,
      deadline_calculation_field_id = excluded.deadline_calculation_field_id,
      transition_at = excluded.transition_at,
      changed_at = pg_catalog.statement_timestamp();
  end if;

  perform vortex_record.write_parent_deadline_due_metadata_internal(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    p_parent_due_transitions
  );
  return result_value;
end
$function$;

alter function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb) owner to vortex_record_adapter;


revoke all on function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) to vortex_runtime;
comment on function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) is
  'Ordinary protected save composed with the engine-derived next deadline transition of the saved record and of every relationship-total parent the save changed.';

create or replace function vortex_record.load_record_access_facts_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  installation jsonb;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; this adapter consumes them and adds none.
  installation := vortex_module.read_current_active_installation();

  -- Step 3: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token <> 'record_data'
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and storage_contract_value = any (provision.storage_contract_ids)
        ) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = context_application_root_id
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', context_application_root_id,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the declaration. Every record-scoped permission of this action
  -- kind declared for this exact record type, owned by the context Application
  -- or by the record type's own Module, in the canonical order the eligibility
  -- core requires.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = p_action_kind
    -- `->>` and not `->`: a permission that declares no named action is stored
    -- here as JSON null, which `-> 'namedAction' is null` would never match, so
    -- that test would leave every declaration empty and refuse every record.
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = target_module_root_id
    );

  declaration := case
    when required_permissions is null then null
    else pg_catalog.jsonb_build_object(
      'operationKey', 'record.' || p_action_kind,
      'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', target_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  end;

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_meta ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );
  target_fact := record_fact;

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;

      load_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(
           ''recordScope'', pg_catalog.jsonb_build_object(
             ''storageScope'', %L,
             ''organizationId'', stored.organisation_id,
             ''moduleRootId'', %L::uuid,
             ''recordTypeId'', %L::uuid,
             ''storageContractId'', %L::uuid,
             ''recordId'', stored.record_id
           ) || case when %L = ''application_contained''
             then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
             else ''{}''::jsonb end,
           ''lifecycleState'', stored.lifecycle_state,
           ''fieldValues'', pg_catalog.jsonb_build_object(%s)
         ) || case
           when stored.owner_organisation_account_id is not null
             then pg_catalog.jsonb_build_object(
               ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
           when stored.owner_group_id is not null
             then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'moduleRootId', meta.value -> 'moduleRootId',
          'recordTypeId', meta.value -> 'recordTypeId',
          'storageContractId', meta.value -> 'storageContractId',
          'storageScope', meta.value -> 'storageScope',
          'ownershipMode', meta.value -> 'ownershipMode',
          'validationContractVersion', meta.value -> 'validationContractVersion',
          'fields', meta.value -> 'fields'
        ) || case
          when meta.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by meta.key collate "C"
      )
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'table', target_table,
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'fieldValues', target_fact -> 'fieldValues'
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_internal(uuid, text, uuid, bigint) owner to vortex_record_adapter;


revoke all on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) is
  'Private adapter fact loader over the exact active installation, including each pinned Module validation contract version.';

create or replace function vortex_record.read_record(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  columns_value jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null);
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object('readableFieldIds',
    vortex_record.project_derived_readable_field_ids_internal(
      loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds',
      bounds -> 'readableFieldIds', '[]'::jsonb
    )
  );
  columns_value := loaded -> 'columns';
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, loaded -> 'fieldValues' -> field_id);
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber', 'values', values_value);
end
$function$;

alter function vortex_record.read_record(uuid, uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.read_record(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record(uuid, uuid) is
  'Fixed record read adapter: returns the readable field projection of one record under the caller''s own current authority, or an identical refusal for a missing, foreign or unreachable record.';

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  field_kind text;
  semantic_type text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  sort_directions text[] := array[]::text[];
  sort_columns text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  scan_sql text;
  scan_record record;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  next_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  due_limit constant integer := 100;
  type_catalogue jsonb;
  all_fields jsonb := '{}'::jsonb;
  closure_ids text[];
  closure_added text[];
  closure_pass integer := 0;
  deadline_ids text[] := array[]::text[];
  deadline_type_ids text[] := array[]::text[];
  due_examined integer := 0;
  due_record record;
  due_projection jsonb;
  due_values jsonb;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;

  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.created_at), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.updated_at), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  -- The verified organisation and Application; never a caller value.
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501', message = 'Query requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;

  resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;

  -- Grouped and totalled shapes are arrangements (#573); relationship hops have
  -- no declared path in this contract. Neither is run as plain rows.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;

  -- The installed physical table for this exact record type.
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
  if not found
    or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
    or catalogue_row.record_type_id <> record_type_id_value
    or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
    or catalogue_row.physical_schema_token <> 'record_data' then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;

  -- Order: the published sort over orderable typed columns, then the record id.
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(query_item -> 'sort') as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = catalogue_row.storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_columns := pg_catalog.array_append(sort_columns, mapping_row.physical_column_token);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(sort_ids) = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;

  -- Filter: the published condition tree over this record type's own fields.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      field_kind := fields_by_id -> field_key ->> 'type';
      if field_kind in ('calculation', 'total') then
        field_kind := fields_by_id -> field_key #>> '{settings,resultType}';
      end if;
      -- The exact (current Module contract) semantics of the saved-condition
      -- evaluator, so Query and database-backed conditions agree.
      semantic_type := case
        when field_kind = 'decimal_number' then 'decimal_number'
        when field_kind = 'money' then 'money'
        when field_kind = 'whole_number' then 'number'
        when field_kind = 'yes_no' then 'boolean'
        when field_kind = 'date' then 'date'
        when field_kind = 'date_time' then 'date_time'
        when field_kind = 'several_choices' then 'text_collection'
        when field_kind in ('table', 'attachment') then 'opaque_json'
        when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
        when field_kind = 'link_to_person' then 'organization_account_reference'
        when field_kind in (
          'text', 'long_text', 'formatted_text', 'choice', 'reference_number',
          'email_address', 'phone_number', 'web_address'
        ) then 'text'
        else null end;
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      -- The same canonical value text the record reader projects; references
      -- are compared by their identifier, as the condition engine defines.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when semantic_type = 'record_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''recordId''))',
              mapping_row.physical_column_token)
          when semantic_type = 'organization_account_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''organizationAccountId''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.%I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs: exactly the declared keys, required ones present, references
  -- reduced to their identifier. Types are checked by the condition bridge.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and (input_item ->> 'required')::boolean then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'recordId'));
    elsif input_value <> 'null'::jsonb and input_item ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['organizationAccountId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'organizationAccountId') ~ uuid_pattern, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'organizationAccountId'));
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The keyset position, which must fit this exact order.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'recordId']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;

  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then pg_catalog.format('stored.%I collate "C"', sort_columns[sort_index])
      else pg_catalog.format('stored.%I', sort_columns[sort_index]) end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when sort_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.%I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'')',
        sort_columns[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(stored.%I, ''YYYY-MM-DD'')', sort_columns[sort_index])
      else pg_catalog.format('stored.%I::text', sort_columns[sort_index]) end);

    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('stored.%I is not null', sort_columns[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('stored.%I is null and ', sort_columns[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('(stored.%I is null or coalesce(%s < %s, false))',
            sort_columns[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix || 'stored.record_id > $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;

  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and %s%s
     order by %s, stored.record_id asc
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    catalogue_row.physical_table_token,
    case when catalogue_row.storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    keyset_sql,
    pg_catalog.array_to_string(order_terms, ', ')
  );

  -- Freshness. The recursive dependency closure of every field this query
  -- filters, sorts or projects, followed through calculation dependencies and
  -- relationship totals, decides whether a deadline calculation feeds it. A
  -- query that no deadline calculation feeds is never refused here.
  if exists (
    select 1
    from pg_catalog.unnest(sort_ids || filter_ids || requested_ids) as referenced(id)
    where fields_by_id -> referenced.id ->> 'type' in ('calculation', 'total')
  ) then
    -- Every installed field, keyed by lowercase identifier and carrying the
    -- record type that owns it.
    type_catalogue := vortex_record.relationship_total_catalogue_internal();
    for field_item in
      select field.value || pg_catalog.jsonb_build_object(
        'ownerRecordTypeId', pg_catalog.lower(type_entry.value ->> 'recordTypeId')
      )
      from pg_catalog.jsonb_array_elements(type_catalogue -> 'recordTypes') as type_entry(value),
        pg_catalog.jsonb_array_elements(coalesce(type_entry.value -> 'fields', '[]'::jsonb)) as field(value)
    loop
      all_fields := all_fields || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
    closure_ids := sort_ids || filter_ids || requested_ids;
    loop
      closure_pass := closure_pass + 1;
      if closure_pass > 64 then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      select coalesce(pg_catalog.array_agg(distinct dependency.id), array[]::text[])
      into closure_added
      from (
        select pg_catalog.lower(dep.value) as id
        from pg_catalog.unnest(closure_ids) as member(id),
          pg_catalog.jsonb_array_elements_text(
            case when all_fields -> member.id ->> 'type' = 'calculation'
              and pg_catalog.jsonb_typeof(all_fields -> member.id #> '{settings,dependencyFieldIds}') = 'array'
              then all_fields -> member.id #> '{settings,dependencyFieldIds}' else '[]'::jsonb end
          ) as dep(value)
        union
        select pg_catalog.lower(all_fields -> member.id #>> '{settings,fieldId}')
        from pg_catalog.unnest(closure_ids) as member(id)
        where all_fields -> member.id ->> 'type' = 'total'
          and all_fields -> member.id #>> '{settings,fieldId}' is not null
        union
        select pg_catalog.lower(referenced.value #>> '{}')
        from pg_catalog.unnest(closure_ids) as member(id),
          pg_catalog.jsonb_path_query(
            coalesce(all_fields -> member.id #> '{settings,filter}', 'null'::jsonb),
            'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value)
        where all_fields -> member.id ->> 'type' = 'total'
      ) as dependency
      where dependency.id is not null and dependency.id <> all (closure_ids);
      exit when pg_catalog.cardinality(closure_added) = 0;
      closure_ids := closure_ids || closure_added;
    end loop;
    select coalesce(pg_catalog.array_agg(member.id), array[]::text[])
    into deadline_ids
    from pg_catalog.unnest(closure_ids) as member(id)
    where all_fields -> member.id ->> 'type' = 'calculation'
      and all_fields -> member.id #>> '{settings,expression,kind}' = 'deadline_passed';
    select coalesce(pg_catalog.array_agg(distinct all_fields -> member.id ->> 'ownerRecordTypeId'),
        array[]::text[])
    into deadline_type_ids
    from pg_catalog.unnest(deadline_ids) as member(id);
  end if;

  -- A due row is the record's earliest pending transition, and it names only
  -- one of its deadline calculations, so any due row on a record of a type that
  -- owns one of these calculations may leave it stale. It matters only when
  -- the caller can read such a calculation on that record (with its own
  -- dependencies); then every observable filter, order, page and projection
  -- may be stale.
  if pg_catalog.cardinality(deadline_type_ids) > 0 then
    for due_record in
      select due.record_type_id, due.record_id
      from vortex_record.record_deadline_due_metadata as due
      where due.organization_id = context_organization_id
        and due.transition_at <= pg_catalog.statement_timestamp()
        and due.record_type_id::text = any (deadline_type_ids)
        and (due.application_root_id is null or due.application_root_id = context_application_root_id)
      order by due.transition_at asc, due.record_id asc
      limit due_limit + 1
    loop
      due_examined := due_examined + 1;
      if due_examined > due_limit then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'freshness_pending');
      end if;
      due_projection := vortex_record.read_record(due_record.record_type_id, due_record.record_id);
      if due_projection ->> 'outcome' = 'allowed' then
        due_values := due_projection -> 'values';
        if exists (
          select 1
          from pg_catalog.unnest(deadline_ids) as deadline(id)
          where all_fields -> deadline.id ->> 'ownerRecordTypeId' = due_record.record_type_id::text
            and due_values ? deadline.id
            and not exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                coalesce(all_fields -> deadline.id #> '{settings,dependencyFieldIds}', '[]'::jsonb)
              ) as dep(value)
              where not (due_values ? pg_catalog.lower(dep.value))
            )
        ) then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'freshness_pending');
        end if;
      end if;
    end loop;
  end if;

  for scan_record in execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1
  loop
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;

    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    if filter_condition is null then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;

    if passes then
      projection := vortex_record.read_record(record_type_id_value, scan_record.record_id);
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ));
          row_count := row_count + 1;
          if pg_catalog.cardinality(system_field_keys) > 0 then
            rows_value := pg_catalog.jsonb_set(
              rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
            );
          end if;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;

    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;

  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'recordId', last_examined_record_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value
  );
end
$function$;

alter function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb) owner to vortex_record_adapter;


revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, with only the declared Record system values, or one refusal before any row is exposed; refuses while a readable due deadline transition feeding the queried fields is unapplied.';

create or replace function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  submitted_id uuid;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    if pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;

    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(vortex_record.allocate_reference_number_internal(
          (context_value ->> 'organizationId')::uuid,
          (meta ->> 'storageContractId')::uuid,
          field_id_value, app_scope, field_item -> 'settings'
        ));
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      column_names := pg_catalog.array_append(
        column_names, pg_catalog.format('%I', column_value ->> 'token')
      );
      column_values := pg_catalog.array_append(column_values,
        case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
          when 'timestamp_with_time_zone' then
            pg_catalog.format('%L::timestamptz', input_value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
          else pg_catalog.format('%L::text', input_value #>> '{}')
        end end
      );
    end loop;

    insert_sql := pg_catalog.format(
      'insert into record_data.%I (
         organisation_id, module_root_id, record_type_id, storage_contract_id,
         record_id, application_root_id, definition_revision,
         owner_organisation_account_id, owner_group_id, lifecycle_state,
         concurrency_number, created_at, created_by, updated_at, updated_by%s
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
         pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)',
      meta ->> 'table',
      case when pg_catalog.cardinality(column_names) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
      case when pg_catalog.cardinality(column_values) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_values, ', ') end
    );
    execute insert_sql using
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'moduleRootId')::uuid, p_record_type_id,
      (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
      (meta ->> 'moduleReleaseRevision')::bigint,
      owner_account_id, owner_group_id,
      (context_value ->> 'organizationAccountId')::uuid;

    -- #858: lock every created link's target row before the data-version bump
    -- and edge pass below, so a multi-link create takes all its row locks
    -- before its data version and any edge identity, as the update writer does.
    -- A malformed or undeclared link is left to the writer's own validation.
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if pg_catalog.jsonb_typeof(input_value) = 'object'
          and input_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
          and pg_catalog.jsonb_typeof(input_value -> 'recordTypeId') = 'string'
          and pg_catalog.jsonb_typeof(input_value -> 'recordId') = 'string'
          and pg_catalog.pg_input_is_valid(input_value ->> 'recordTypeId', 'uuid')
          and pg_catalog.pg_input_is_valid(input_value ->> 'recordId', 'uuid')
          and pg_catalog.lower(input_value ->> 'recordTypeId') <>
            '00000000-0000-0000-0000-000000000000'
          and pg_catalog.lower(input_value ->> 'recordId') <>
            '00000000-0000-0000-0000-000000000000'
          and vortex_record.relationship_declares_target_internal(
            relationship_value, (input_value ->> 'recordTypeId')::uuid
          ) then
          perform vortex_record.lock_relationship_target_row_internal(
            (input_value ->> 'recordTypeId')::uuid,
            (input_value ->> 'recordId')::uuid,
            (context_value ->> 'organizationId')::uuid
          );
        end if;
      end if;
    end loop;
    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, record_id_value,
          (relationship_value ->> 'relationshipId')::uuid,
          final_values -> pg_catalog.lower(field_id_value::text), false
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'create', record_id_value, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'access_refused';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    foreach submitted_id in array p_submitted_field_ids loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', 1, 'values', final_values
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

alter function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid) is
  'Private fixed create primitive: derives scope, definition and human ownership, generates references, writes typed values and relationships, and decides create authority over the proposed record in one rollback-safe transaction.';

create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  existing_other boolean;
  target_locked boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_increment_source_revision is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id =
      (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_increment_source_revision then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null%s
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token',
      case when p_increment_source_revision then
        ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $3'
      else '' end
    );
    if p_increment_source_revision then
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id, (source_context ->> 'organizationAccountId')::uuid;
    else
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id;
    end if;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;

  -- Prevent a selected target disappearing while its unconstrainted edge is
  -- installed. EXECUTE does not update PL/pgSQL FOUND, so capture the selected
  -- value explicitly. Then rebuild eligibility from the now-locked current row
  -- rather than trusting a decision made before a concurrent deletion waited.
  target_locked := false;
  execute pg_catalog.format(
    'select true from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active'' for share',
    target_meta ->> 'table'
  ) into target_locked using
    (source_context ->> 'organizationId')::uuid, target_record_id;
  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  target_loaded := vortex_record.load_record_access_facts_internal(
    target_type_id, 'read', target_record_id, null
  );
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_increment_source_revision then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  );
  if p_increment_source_revision then
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value,
      (source_context ->> 'organizationAccountId')::uuid;
  else
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value;
  end if;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) owner to vortex_record_adapter;


revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: resolves the declared storage mapping and target eligibility, locks the target row and shared edge identities, then replaces the source link edge and typed value atomically.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
