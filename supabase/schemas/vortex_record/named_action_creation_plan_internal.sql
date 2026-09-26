create or replace function vortex_record.named_action_creation_plan_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  task_value jsonb;
  task_ordinal integer;
  target_type_id uuid;
  target_meta jsonb;
  target_type jsonb;
  ownership_mode text;
  field_key text;
  field_value jsonb;
  relationship_value jsonb;
  create_targets jsonb := '[]'::jsonb;
  supplied jsonb;
  expected_plan jsonb := '[]'::jsonb;
  supplied_plan jsonb := '[]'::jsonb;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- #569: a create-bearing command may also change the subject's own links.
  -- The inversion this used to guard against (the subject's relationship edge
  -- identities L6 before a created record's reference-number counter L4 and
  -- data version) is closed by the terminal writer, which reserves every
  -- creation's counters and every affected data version before the subject
  -- writer runs.

  for task_value, task_ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if task_value ->> 'type' <> 'record.create' then continue; end if;
    if task_value #>> '{properties,recordType,state}' is distinct from 'resolved'
      or not pg_catalog.pg_input_is_valid(
        task_value #>> '{properties,recordType,recordTypeId}', 'uuid'
      )
      or pg_catalog.jsonb_typeof(task_value -> 'properties' -> 'values') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    target_type_id := (task_value #>> '{properties,recordType,recordTypeId}')::uuid;
    target_meta := vortex_record.resolve_record_action_context_internal(
      target_type_id, 'create'
    );
    target_type := target_meta -> 'recordType';
    if pg_catalog.jsonb_typeof(target_type) <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    ownership_mode := target_type ->> 'ownershipMode';

    -- Refusal 1: #50 forbids a caller-supplied final owner, so
    -- `p_selected_group_id` is permanently null and a `group` target could only
    -- fail with `owner_unavailable` after its insert.
    if ownership_mode = 'group' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_owner_unsupported'
      );
    end if;
    -- Refusal 2: an `inherited` target derives its owner from one declared
    -- relationship, which the authored field map must name.
    if ownership_mode = 'inherited'
      and not (task_value -> 'properties' -> 'values') ? pg_catalog.lower(
        target_type ->> 'ownershipRelationshipId'
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
      );
    end if;

    for field_key in
      select pg_catalog.lower(item.value)
      from pg_catalog.jsonb_object_keys(task_value -> 'properties' -> 'values') item(value)
    loop
      select item.value into field_value
      from pg_catalog.jsonb_array_elements(target_type -> 'fields') item(value)
      where pg_catalog.lower(item.value ->> 'fieldId') = field_key;
      if field_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_field_unknown'
        );
      end if;
      if field_value ->> 'type' = 'reference_number' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_generated_field'
        );
      end if;
      -- Refusal 3: only to-one link semantics are implemented. A link names its
      -- single declared target and a link to one of several record types its
      -- declared list; the edge writer proves the concrete target a member.
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into relationship_value
        from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
        where pg_catalog.lower(item.value ->> 'fromFieldId') = field_key;
        if relationship_value is null
          or not (relationship_value ? case field_value ->> 'type'
            when 'link' then 'toRecordType' else 'toRecordTypes' end)
          or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
          return pg_catalog.jsonb_build_object(
            'outcome', 'unsupported', 'reasonCode', 'create_target_relationship_unsupported'
          );
        end if;
      end if;
    end loop;

    create_targets := create_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', task_ordinal,
        'recordTypeId', target_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_meta ->> 'storageScope',
        'ownershipMode', ownership_mode,
        'recordType', target_type
      )
    );
    expected_plan := expected_plan || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', task_ordinal,
        'recordTypeId', pg_catalog.lower(target_type_id::text),
        'valueFieldIds', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
          from pg_catalog.jsonb_object_keys(task_value -> 'properties' -> 'values') item(value)
        ), '[]'::jsonb)
      )
    );
  end loop;

  if p_creations is not null then
    if pg_catalog.jsonb_typeof(p_creations) <> 'array' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    for supplied in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(supplied) <> 'object'
        or not (supplied ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
        or pg_catalog.jsonb_typeof(supplied -> 'values') <> 'object'
        or pg_catalog.jsonb_typeof(supplied -> 'finalValues') <> 'object'
        or not pg_catalog.pg_input_is_valid(supplied ->> 'recordTypeId', 'uuid') then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      supplied_plan := supplied_plan || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'ordinal', (supplied ->> 'ordinal')::integer,
          'recordTypeId', pg_catalog.lower((supplied ->> 'recordTypeId')::uuid::text),
          'valueFieldIds', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
            from pg_catalog.jsonb_object_keys(supplied -> 'values') item(value)
          ), '[]'::jsonb)
        )
      );
    end loop;
    if supplied_plan is distinct from expected_plan then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'creation_plan_mismatch'
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'planned', 'createTargets', create_targets
  );
exception
  when no_data_found or too_many_rows then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
    );
end
$function$;

revoke all on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb
) is
  'Private named-action step: resolves every record.create task of the installed action against the exact active installation, refuses an unsupported creation shape, and returns the creation plan the command must supply back verbatim.';
