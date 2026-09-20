-- #511: write the named action set-field writer explicitly instead of generating
-- it from another function's source text, and deliver that as a new migration.
--
-- `20260915030000_atomic_named_action_writer.sql` does not write
-- `vortex_record.save_named_action_set_fields_internal`. It generates it at
-- migration time, by applying seventeen chained `pg_catalog.replace()` calls to
-- `pg_get_functiondef` of `vortex_record.save_base_record`. Three of those
-- argument-list substitutions no longer matched the source they were written
-- against, so the generated body called
-- `vortex_record.append_named_action_activity_internal` with the base writer's
-- five arguments against the only overload that exists, which takes four. The
-- clone's integrity guard checks identifier names and never argument arity, so
-- the migration succeeded and shipped an unresolvable call; `supabase db lint`
-- reports it at error level.
--
-- #514 corrected those substitutions inside `20260915030000` itself. That file
-- is already recorded in the Testing database's
-- `supabase_migrations.schema_migrations`, so `supabase db push` skips it and the
-- database keeps the writer generated before the correction. This migration is
-- the delivery: it replaces the existing object with an explicit body, on a
-- database that already holds the broken one as much as on a fresh cluster.
--
-- Generation is removed rather than repaired because a body assembled from
-- another function's source text drifts silently whenever that source changes,
-- and no guard over the assembled text can see an argument list that was never
-- rewritten. The body below is the same reviewed base-save algorithm with the
-- named-action seams `20260915030000` closes, byte-identical to what that
-- migration generates on a fresh cluster, so nothing else about the writer
-- changes. `vortex_record.save_base_record` is untouched.
--
-- All four `append_named_action_activity_internal` call sites use the declared
-- `(uuid, uuid, uuid[], text)` overload: the update access refusal, the
-- proposed-facts refusal, the create access refusal, and the completed save.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.save_named_action_set_fields_internal(
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
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_inputs jsonb
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
  receipt vortex_record.named_action_command_receipts%rowtype;
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
    or p_operation is distinct from 'update'
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
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

  command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );

  insert into vortex_record.named_action_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, command_fingerprint, action_owner_kind, action_owner_id,
    action_release_revision, action_id, record_type_id, record_id, state
  ) values (
    organization_id_value, application_root_id_value, actor_id_value,
    p_command_id, command_fingerprint_value, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    'pending'
  )
  on conflict do nothing
  returning command_id into inserted_command_id;

  if inserted_command_id is null then
    select stored.* into strict receipt
    from vortex_record.named_action_command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_id = p_command_id
    for update;
    if receipt.command_fingerprint is distinct from command_fingerprint_value
      or receipt.action_owner_kind is distinct from p_action_owner_kind
      or receipt.action_owner_id is distinct from p_action_owner_id
      or receipt.action_release_revision is distinct from p_action_release_revision
      or receipt.action_id is distinct from p_action_id
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt.state is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, receipt.record_id
    );
    if projection ->> 'outcome' <> 'completed' then
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

  meta := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    delete from vortex_record.named_action_command_receipts
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
      delete from vortex_record.named_action_command_receipts
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
        or field_value ->> 'type' <> 'link'
        or not (relationship_value ? 'toRecordType')
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        delete from vortex_record.named_action_command_receipts
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
          'targetRecordTypeId', relationship_value #> '{toRecordType,recordTypeId}',
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
      delete from vortex_record.named_action_command_receipts
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
      delete from vortex_record.named_action_command_receipts
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
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      delete from vortex_record.named_action_command_receipts
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
      delete from vortex_record.named_action_command_receipts
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
      activity_time := vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      delete from vortex_record.named_action_command_receipts
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
        delete from vortex_record.named_action_command_receipts
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
          delete from vortex_record.named_action_command_receipts
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
        if target_record_type_id <>
          (relationship_change ->> 'targetRecordTypeId')::uuid then
          delete from vortex_record.named_action_command_receipts
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
          delete from vortex_record.named_action_command_receipts
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
          delete from vortex_record.named_action_command_receipts
          where organization_id = organization_id_value
            and application_root_id = application_root_id_value
            and actor_organization_account_id = actor_id_value
            and command_id = p_command_id;
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

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
      activity_time := vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      delete from vortex_record.named_action_command_receipts
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
      delete from vortex_record.named_action_command_receipts
      where organization_id = organization_id_value
        and application_root_id = application_root_id_value
        and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      mutation := vortex_record.change_record_by_named_action_internal(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids,
        p_action_owner_kind, p_action_owner_id, p_action_release_revision, p_action_id
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
        order by item.value ->> 'fieldId'
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
      activity_time := vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    delete from vortex_record.named_action_command_receipts
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

  activity_time := vortex_record.append_named_action_activity_internal(
    p_activity_id, saved_record_id, changed_field_ids, 'completed'
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

  update vortex_record.named_action_command_receipts as stored
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

  projection := vortex_record.project_named_action_record_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, saved_record_id
  );
  if projection ->> 'outcome' <> 'completed' then
    raise exception using errcode = '55000',
      message = 'Named action Record projection is unavailable';
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

alter function vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function
  vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb)
to vortex_record_adapter;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
