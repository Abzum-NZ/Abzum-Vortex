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
        or not coalesce(pg_catalog.pg_input_is_valid(saved_target ->> 'concurrencyNumber', 'bigint'), false) then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
      saved_record_id := (saved_target ->> 'recordId')::uuid;
      saved_concurrency := (saved_target ->> 'concurrencyNumber')::bigint;
      if saved_record_id is distinct from target_row.record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency not between 1 and 9007199254740991 then
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
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
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
