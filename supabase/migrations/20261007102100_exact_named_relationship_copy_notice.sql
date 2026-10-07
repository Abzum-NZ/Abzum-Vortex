-- #2082: publish one exact final notice for each named relationship-copy target.
begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.change_record_relationship_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_relationship_id uuid,
  p_target_value jsonb
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
  decision jsonb;
  bounds jsonb;
  field_id_value uuid;
  relationship_value jsonb;
  new_concurrency bigint;
  saved_record_id uuid;
  notice_sequence bigint;
  exact_copy_notice boolean := false;
  preview_installation jsonb;
  refusal_reason text := 'relationship_change_refused';
begin
  if p_record_type_id is null or p_record_id is null or p_relationship_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_value is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'update');
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    select item.value into relationship_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
    where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
    if not found then
      refusal_reason := 'relationship_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(
        bounds -> 'changeableFieldIds'
      ) as allowed(value)
      where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id_value::text)
    ) then
      refusal_reason := 'field_not_changeable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    exact_copy_notice := preview_installation is null
      and meta ->> 'storageScope' = 'application_contained';
    if exact_copy_notice then
      -- The copy plan holds source and linked-row locks. Reserve the nonblocking
      -- sequence before edges; the grouped copy owner publishes the final tuple.
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_record.write_relationship_value_internal(
        p_record_type_id, p_record_id, p_relationship_id, p_target_value, false
      );
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $6
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.record_type_id = $3 and stored.application_root_id = $4
           and stored.lifecycle_state = ''active''
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number', meta ->> 'table'
      ) into strict saved_record_id, new_concurrency using
        (meta -> 'context' ->> 'organizationId')::uuid, p_record_id,
        p_record_type_id, (meta -> 'context' ->> 'applicationRootId')::uuid,
        p_expected_concurrency_number,
        (meta -> 'context' ->> 'organizationAccountId')::uuid;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or new_concurrency is null
        or new_concurrency not between 1 and 9007199254740991
        or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
    else
      perform vortex_record.write_relationship_value_internal(
        p_record_type_id, p_record_id, p_relationship_id, p_target_value, true
      );
      execute pg_catalog.format(
        'select concurrency_number from record_data.%I
         where organisation_id = $1 and record_id = $2', meta ->> 'table'
      ) into new_concurrency using
        (meta -> 'context' ->> 'organizationId')::uuid, p_record_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', case when exact_copy_notice
        then saved_record_id else p_record_id end,
      'concurrencyNumber', new_concurrency
    ) || case when exact_copy_notice then pg_catalog.jsonb_build_object(
      'noticeSequence', notice_sequence
    ) else '{}'::jsonb end;
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', refusal_reason);
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or check_violation or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
      );
  end;
end
$function$;

alter function vortex_record.change_record_relationship_internal(uuid,uuid,bigint,uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb) is
  'Private revision-checked relationship primitive: decides source update and target eligibility, changes the edge atomically, and returns the actual saved identity, revision and reserved sequence for the live application-contained copy owner to publish.';

create or replace function vortex_record.apply_named_action_relationship_copies_internal(
  p_plan jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  copy_value jsonb;
  target_row record;
  meta jsonb;
  target_concurrency bigint;
  changed_result jsonb;
  event_result jsonb;
  saved_targets jsonb := '{}'::jsonb;
  target_key text;
  saved_target jsonb;
  saved_record_id uuid;
  saved_concurrency bigint;
  notice_sequence bigint;
  exact_copy_notice boolean;
  preview_installation jsonb;
begin
  if p_plan ->> 'outcome' is distinct from 'planned'
    or pg_catalog.jsonb_typeof(p_plan -> 'copies') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Relationship copy plan is invalid';
  end if;
  for copy_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_plan -> 'copies') item(value)
    order by (item.value ->> 'relationshipId')::uuid,
      (item.value #>> '{value,recordId}')::uuid,
      (item.value ->> 'targetRecordId')::uuid
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      (copy_value ->> 'targetRecordTypeId')::uuid, 'update'
    );
    -- The target row is already locked by the plan; each write bumps its
    -- revision, so the next write is against the revision just reached.
    target_concurrency := null;
    execute pg_catalog.format(
      'select stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active''',
      meta ->> 'table'
    ) into target_concurrency
      using (meta -> 'context' ->> 'organizationId')::uuid,
        (copy_value ->> 'targetRecordId')::uuid;
    if target_concurrency is null then
      raise exception using errcode = '55000', message = 'Relationship copy target lock was lost';
    end if;
    changed_result := vortex_record.change_record_relationship_internal(
      (copy_value ->> 'targetRecordTypeId')::uuid, (copy_value ->> 'targetRecordId')::uuid,
      target_concurrency, (copy_value ->> 'relationshipId')::uuid, copy_value -> 'value'
    );
    if changed_result ->> 'outcome' = 'conflict' then
      raise exception using errcode = '40001', message = 'Relationship copy conflicted';
    end if;
    if changed_result ->> 'outcome' is distinct from 'completed' then
      raise exception using errcode = '42501',
        message = 'Relationship copy was refused',
        detail = coalesce(changed_result ->> 'reasonCode', changed_result ->> 'outcome');
    end if;
    target_key := (copy_value ->> 'targetRecordTypeId')::uuid::text || ':'
      || (copy_value ->> 'targetRecordId')::uuid::text;
    -- The next copy can revise this target again. Keep its last saved tuple so
    -- the grouped owner emits only the revision reached by all of its copies.
    saved_targets := saved_targets || pg_catalog.jsonb_build_object(
      target_key, changed_result
    );
  end loop;

  for target_row in
    select (item.value ->> 'targetRecordTypeId')::uuid as record_type_id,
      (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.array_agg(
        distinct (item.value ->> 'fromFieldId')::uuid
        order by (item.value ->> 'fromFieldId')::uuid
      ) as changed_field_ids
    from pg_catalog.jsonb_array_elements(p_plan -> 'copies') item(value)
    group by 1, 2
    order by 1, 2
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      target_row.record_type_id, 'update'
    );
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    exact_copy_notice := preview_installation is null
      and meta ->> 'storageScope' = 'application_contained';
    if exact_copy_notice then
      target_key := target_row.record_type_id::text || ':' || target_row.record_id::text;
      saved_target := saved_targets -> target_key;
      if pg_catalog.jsonb_typeof(saved_target) is distinct from 'object'
        or saved_target ->> 'outcome' is distinct from 'completed'
        or pg_catalog.jsonb_typeof(saved_target -> 'recordId') is distinct from 'string'
        or not coalesce(pg_catalog.pg_input_is_valid(saved_target ->> 'recordId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(saved_target -> 'concurrencyNumber') is distinct from 'number'
        or not coalesce(pg_catalog.pg_input_is_valid(saved_target ->> 'concurrencyNumber', 'bigint'), false)
        or pg_catalog.jsonb_typeof(saved_target -> 'noticeSequence') is distinct from 'number'
        or not coalesce(pg_catalog.pg_input_is_valid(saved_target ->> 'noticeSequence', 'bigint'), false) then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
      saved_record_id := (saved_target ->> 'recordId')::uuid;
      saved_concurrency := (saved_target ->> 'concurrencyNumber')::bigint;
      notice_sequence := (saved_target ->> 'noticeSequence')::bigint;
      if saved_record_id is distinct from target_row.record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency not between 1 and 9007199254740991
        or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
    end if;
    perform vortex_record.append_named_action_activity_internal(
      pg_catalog.gen_random_uuid(), target_row.record_id, target_row.changed_field_ids,
      'completed'
    );
    event_result := vortex_event.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid, target_row.record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', pg_catalog.gen_random_uuid(),
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'changed',
          'recordTypeId', target_row.record_type_id
        ),
        'payload', pg_catalog.jsonb_build_object(
          'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(target_row.changed_field_ids)
        )
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000',
        message = 'Relationship copy Event append failed';
    end if;
    if exact_copy_notice then
      begin
        perform vortex_invalidation.publish_change_notice(
          (meta -> 'context' ->> 'organizationId')::uuid,
          (meta -> 'context' ->> 'applicationRootId')::uuid,
          target_row.record_type_id, saved_record_id, saved_concurrency, 'changed',
          notice_sequence, notice_sequence,
          (meta -> 'context' ->> 'correlationId')::uuid
        );
      exception
        when others then
          -- Invalidation is advisory; losing a notice must not refuse a copy.
          null;
      end;
    end if;
  end loop;
end
$function$;

alter function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.apply_named_action_relationship_copies_internal(jsonb) is
  'Private named-action step: writes planned copies against each target''s current revision in edge order, records grouped Activity and changed Events, and publishes one exact notice per live application-contained target using its final saved tuple. Any mutation refusal raises so the whole command rolls back.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
