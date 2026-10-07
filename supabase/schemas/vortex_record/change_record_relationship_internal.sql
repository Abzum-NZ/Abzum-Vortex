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
