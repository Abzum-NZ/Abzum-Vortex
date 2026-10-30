create or replace function vortex_record.prepare_named_record_change_intents_internal(
  p_named_action jsonb,
  p_subjects jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_reference jsonb;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  policy jsonb;
  subject jsonb;
  subject_index integer;
  supplied_fields jsonb;
  root_fields jsonb;
  root_delete boolean;
  root_seen boolean := false;
  copy_field_ids jsonb;
  create_entry jsonb;
  create_ordinal integer;
  used_creates integer[] := array[]::integer[];
  target_meta jsonb;
  create_targets jsonb := '[]'::jsonb;
  copied_targets uuid[] := array[]::uuid[];
  roles jsonb := '{}'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_named_action) is distinct from 'object'
    or not (p_named_action ?& array['action', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'inputs'])
    or p_named_action - array['action', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'inputs']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named_action ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(p_named_action ->> 'recordId')
    or not coalesce(pg_catalog.pg_input_is_valid(p_named_action ->> 'expectedConcurrencyNumber', 'bigint'), false)
    or (p_named_action ->> 'expectedConcurrencyNumber')::bigint not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_named_action -> 'inputs') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_reference := p_named_action -> 'action';
  if pg_catalog.jsonb_typeof(action_reference) is distinct from 'object'
    or not (action_reference ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId'])
    or action_reference - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId']::text[] <> '{}'::jsonb
    or action_reference ->> 'ownerKind' not in ('application', 'module')
    or not vortex_platform.is_non_nil_uuid(action_reference ->> 'ownerId')
    or not vortex_platform.is_non_nil_uuid(action_reference ->> 'actionId')
    or not coalesce(pg_catalog.pg_input_is_valid(action_reference ->> 'releaseRevision', 'bigint'), false)
    or (action_reference ->> 'releaseRevision')::bigint not between 1 and 9007199254740991 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_context := vortex_record.resolve_named_action_context_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid
  );
  loaded := vortex_record.load_named_action_facts_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, (p_named_action ->> 'recordId')::uuid,
    (p_named_action ->> 'expectedConcurrencyNumber')::bigint
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'stale_revision');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (p_named_action ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  if not vortex_record.validate_named_action_reference_inputs_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, p_named_action -> 'inputs'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_inputs_invalid');
  end if;
  policy := action_context #> '{action,writePolicy}';
  if pg_catalog.jsonb_typeof(policy) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  -- What the action may write is the write policy derived from its published flow. The flow's
  -- record steps are planned by the flow runner; this only proves each intent is within the policy.
  root_fields := policy -> 'subjectFieldIds';
  root_delete := (policy ->> 'deletesSubject')::boolean;
  if root_delete and pg_catalog.jsonb_array_length(root_fields) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(relationship.value ->> 'fromFieldId')), '[]'::jsonb)
  into copy_field_ids
  from pg_catalog.jsonb_array_elements(policy -> 'relationshipCopies') as copied(value)
  cross join pg_catalog.jsonb_array_elements(copied.value -> 'relationshipIds') as copied_id(value)
  join pg_catalog.jsonb_array_elements(action_context -> 'recordType' -> 'relationships') as relationship(value)
    on pg_catalog.lower(relationship.value ->> 'relationshipId') = pg_catalog.lower(copied_id.value #>> '{}');

  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(field.key)), '[]'::jsonb)
    into supplied_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key);
    if subject ->> 'operation' = 'create' then
      -- A creation is one the policy allows: its record type, and no field the flow does not set.
      create_entry := null;
      select entry.value, (entry.ordinality - 1)::integer into create_entry, create_ordinal
      from pg_catalog.jsonb_array_elements(policy -> 'creates') with ordinality as entry(value, ordinality)
      where pg_catalog.lower(entry.value ->> 'recordTypeId') = pg_catalog.lower(subject ->> 'recordTypeId')
        and not ((entry.ordinality - 1)::integer = any(used_creates))
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements_text(supplied_fields) as supplied(key)
          where not exists (
            select 1 from pg_catalog.jsonb_array_elements_text(entry.value -> 'fieldIds') as allowed(key)
            where pg_catalog.lower(allowed.key) = supplied.key
          )
        )
      order by entry.ordinality
      limit 1;
      if create_entry is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      used_creates := pg_catalog.array_append(used_creates, create_ordinal);
      -- The record type is resolved for the create the way the common writer resolves it; the
      -- owner Group and every field are decided by the common writer like a Save step.
      target_meta := vortex_record.resolve_record_action_context_internal(
        (subject ->> 'recordTypeId')::uuid, 'create'
      );
      if pg_catalog.jsonb_typeof(target_meta -> 'recordType') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
        );
      end if;
      create_targets := create_targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', pg_catalog.jsonb_array_length(create_targets),
        'recordTypeId', subject -> 'recordTypeId',
        'recordType', target_meta -> 'recordType',
        'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
          (target_meta ->> 'moduleRootId')::uuid,
          (target_meta ->> 'moduleReleaseRevision')::bigint,
          (subject ->> 'recordTypeId')::uuid
        )
      ));
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'creation');
    elsif subject -> 'recordTypeId' = p_named_action -> 'recordTypeId'
      and subject -> 'recordId' = p_named_action -> 'recordId' then
      if root_seen or subject -> 'expectedConcurrencyNumber' is distinct from p_named_action -> 'expectedConcurrencyNumber'
        or (root_delete and subject ->> 'operation' <> 'delete')
        or (not root_delete and (subject ->> 'operation' <> 'update' or pg_catalog.jsonb_array_length(root_fields) = 0))
        or exists (
          select 1 from pg_catalog.jsonb_array_elements_text(supplied_fields) as supplied(key)
          where not exists (
            select 1 from pg_catalog.jsonb_array_elements_text(root_fields) as allowed(key)
            where pg_catalog.lower(allowed.key) = supplied.key
          )
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_subject_mismatch');
      end if;
      root_seen := true;
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'subject');
    else
      -- A relationship copy updates another record of the subject's type, only on the link
      -- fields of the relationships the policy lists; the planner derived the values.
      if subject ->> 'operation' <> 'update'
        or subject -> 'recordTypeId' is distinct from p_named_action -> 'recordTypeId'
        or pg_catalog.jsonb_array_length(supplied_fields) = 0
        or (subject ->> 'recordId')::uuid = any(copied_targets)
        or exists (
          select 1 from pg_catalog.jsonb_array_elements_text(supplied_fields) as supplied(key)
          where not exists (
            select 1 from pg_catalog.jsonb_array_elements_text(copy_field_ids) as allowed(key)
            where allowed.key = supplied.key
          )
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_copy_plan_mismatch');
      end if;
      copied_targets := pg_catalog.array_append(copied_targets, (subject ->> 'recordId')::uuid);
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'copy');
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'actionContext', action_context,
    'loaded', loaded, 'bounds', bounds, 'intentRoles', roles, 'createTargets', create_targets);
end
$function$;

alter function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) is
  'Private named-command authority and intent scope: verifies the exact installed action, current subject permission and revision, and that every intent is within the write policy derived from the action''s flow (subject fields or delete, creates, relationship copy fields) before the common record writer prepares its graph. It plans nothing.';
