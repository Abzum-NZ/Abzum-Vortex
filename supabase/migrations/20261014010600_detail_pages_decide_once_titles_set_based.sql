set local role vortex_owner;

-- Every function below is owned by the fixed record adapter.
set local role vortex_record_adapter;


create or replace function vortex_record.named_action_creation_plan_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_creations jsonb,
  p_action_context jsonb
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
  owner_group_count integer;
  ownership_relationship jsonb;
  ownership_field jsonb;
  ownership_field_id text;
  field_key text;
  field_value jsonb;
  relationship_value jsonb;
  create_targets jsonb := '[]'::jsonb;
  supplied jsonb;
  expected_plan jsonb := '[]'::jsonb;
  supplied_plan jsonb := '[]'::jsonb;
begin
  -- The caller resolved this exact installed action once for its whole step.
  action_context := p_action_context;

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

    -- A named action has no owner Group selection. A single live Group
    -- membership identifies its owner without trusting a caller-supplied ID.
    -- The insert phase checks the same membership again under a lock.
    if ownership_mode = 'group' then
      select pg_catalog.count(*) into owner_group_count
      from vortex_access.list_current_record_owner_groups();
      if owner_group_count <> 1 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', case when owner_group_count = 0
            then 'create_target_owner_unavailable'
            else 'create_target_owner_ambiguous' end
        );
      end if;
    end if;
    -- Refusal 2: an `inherited` target derives its owner from one declared
    -- relationship. Authored values name its source field, not its identity.
    if ownership_mode = 'inherited' then
      if pg_catalog.pg_input_is_valid(
          target_type ->> 'ownershipRelationshipId', 'uuid'
        ) is distinct from true
        or pg_catalog.jsonb_typeof(target_type -> 'relationships') is distinct from 'array'
        or pg_catalog.jsonb_typeof(target_type -> 'fields') is distinct from 'array' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;

      select item.value into strict ownership_relationship
      from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') = pg_catalog.lower(
        target_type ->> 'ownershipRelationshipId'
      );
      if pg_catalog.pg_input_is_valid(
          ownership_relationship ->> 'fromRecordTypeId', 'uuid'
        ) is distinct from true
        or pg_catalog.lower(ownership_relationship ->> 'fromRecordTypeId')
          is distinct from target_type_id::text
        or pg_catalog.pg_input_is_valid(
          ownership_relationship ->> 'fromFieldId', 'uuid'
        ) is distinct from true then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;

      ownership_field_id := pg_catalog.lower(ownership_relationship ->> 'fromFieldId');
      select item.value into strict ownership_field
      from pg_catalog.jsonb_array_elements(target_type -> 'fields') item(value)
      where pg_catalog.lower(item.value ->> 'fieldId') = ownership_field_id;
      if (ownership_field ->> 'type' in ('link', 'link_to_one_of_several'))
          is distinct from true
        or (ownership_relationship ->> 'cardinality' in ('one_to_one', 'many_to_one'))
          is distinct from true
        or not (ownership_relationship ? case ownership_field ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or (select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
          where pg_catalog.lower(item.value ->> 'fromFieldId') = ownership_field_id) <> 1 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_relationship_unsupported'
        );
      end if;
      if not (task_value -> 'properties' -> 'values') ? ownership_field_id then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;
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
        'recordType', target_type,
        'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
          (target_meta ->> 'moduleRootId')::uuid,
          (target_meta ->> 'moduleReleaseRevision')::bigint,
          target_type_id
        )
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

alter function vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb, jsonb
) to vortex_record_adapter;
comment on function vortex_record.named_action_creation_plan_internal(
  text, uuid, bigint, uuid, uuid, jsonb, jsonb
) is
  'Private named-action step over the installed action its caller resolved: resolves every record.create task against the exact active installation, refuses an unsupported creation shape, and returns the creation plan the command must supply back verbatim.';


create or replace function vortex_record.prepare_named_action_relationship_copies_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid,
  p_inputs jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  action_context jsonb;
  subject_meta jsonb;
  loaded jsonb;
  decision jsonb;
  readable_field_ids jsonb;
  catalogue jsonb;
  change_value jsonb;
  task_ordinal bigint;
  input_candidate jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_concurrency bigint;
  relationship_text text;
  relationship_value jsonb;
  edge_row record;
  existing_row record;
  edge_type_id uuid;
  planned_keys text[] := array[]::text[];
  copies jsonb := '[]'::jsonb;
  lock_row record;
begin
  if p_subject_record_type_id is null or p_subject_record_id is null
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Relationship copy is invalid';
  end if;
  -- The caller resolved this exact installed action once for its whole step.
  action_context := p_action_context;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'tasks'
    ) item(value)
    where item.value ->> 'type' = 'record.changes'
  ) then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  subject_meta := vortex_record.resolve_record_action_context_internal(
    p_subject_record_type_id, 'update'
  );

  -- What the actor can currently read of the subject under this named action.
  -- The subject is authorised by the installed action, never by ordinary
  -- update authority, exactly as its own writer decides it.
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_subject_record_type_id, p_subject_record_id, null
  );
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_subject_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  readable_field_ids := vortex_access.resolve_record_field_bounds_internal(decision)
    -> 'readableFieldIds';
  if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'Relationship copy field bounds are unavailable';
  end if;

  -- Discover every target and copy first, then lock: a target row lock is the
  -- first lock class, so it is taken as soon as the target is known.
  for change_value, task_ordinal in
    select change.value, task.ordinality
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
      with ordinality as task(value, ordinality)
    cross join lateral pg_catalog.jsonb_array_elements(
      task.value -> 'properties' -> 'changes'
    ) with ordinality as change(value, ordinality)
    where task.value ->> 'type' = 'record.changes'
    order by task.ordinality, change.ordinality
  loop
    -- The target is the declared `record_reference` input's record link, the
    -- one value shape that input accepts.
    input_candidate := p_inputs -> (change_value ->> 'targetInputKey');
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
      where item.value ->> 'key' = change_value ->> 'targetInputKey'
        and item.value ->> 'type' = 'record_reference'
    ) or pg_catalog.jsonb_typeof(input_candidate) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    if not (input_candidate ?& array['recordTypeId', 'recordId'])
      or input_candidate - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
      or not coalesce(pg_catalog.pg_input_is_valid(input_candidate ->> 'recordTypeId', 'uuid'), false)
      or not coalesce(pg_catalog.pg_input_is_valid(input_candidate ->> 'recordId', 'uuid'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    target_type_id := (input_candidate ->> 'recordTypeId')::uuid;
    target_record_id := (input_candidate ->> 'recordId')::uuid;
    -- The copied relationships are the subject's own, so only another record of
    -- the subject's record type can hold them.
    if target_type_id <> p_subject_record_type_id
      or target_record_id = p_subject_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable'
      );
    end if;

    -- L1: the target row, exclusively, before any linked row or edge identity.
    target_concurrency := null;
    execute pg_catalog.format(
      'select stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      subject_meta ->> 'table'
    ) into target_concurrency using organization_id_value, target_record_id;
    if target_concurrency is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable'
      );
    end if;

    for relationship_text in
      select distinct pg_catalog.lower(item.value #>> '{}')
      from pg_catalog.jsonb_array_elements(change_value -> 'relationshipIds') item(value)
      order by 1
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(
        action_context -> 'recordType' -> 'relationships'
      ) item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') = relationship_text
        and pg_catalog.lower(item.value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_subject_record_type_id::text);
      if relationship_value is null
        or relationship_value ->> 'cardinality' is distinct from 'many_to_one'
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements_text(readable_field_ids) readable(value)
          where pg_catalog.lower(readable.value) =
            pg_catalog.lower(relationship_value ->> 'fromFieldId')
        )
        -- The plan copies the subject's edge as it stands before this command
        -- writes the subject, which is only the authored order's edge when no
        -- earlier record.set_fields task sets that same link.
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks')
            with ordinality as earlier(value, ordinality)
          cross join lateral pg_catalog.jsonb_object_keys(
            earlier.value -> 'properties' -> 'values'
          ) key(field_key)
          where earlier.ordinality < task_ordinal
            and earlier.value ->> 'type' = 'record.set_fields'
            and pg_catalog.lower(key.field_key) =
              pg_catalog.lower(relationship_value ->> 'fromFieldId')
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_unavailable'
        );
      end if;

      catalogue := coalesce(catalogue, vortex_record.relationship_total_catalogue_internal());
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') type_item(value)
        cross join pg_catalog.jsonb_array_elements(type_item.value -> 'fields') field_item(value)
        where field_item.value ->> 'type' = 'total'
          and pg_catalog.lower(field_item.value #>> '{settings,relationshipId}') = relationship_text
      ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;

      -- Two changes may name the same target and relationship; it is copied once.
      if (target_record_id::text || ':' || relationship_text) = any (planned_keys) then
        continue;
      end if;
      planned_keys := pg_catalog.array_append(
        planned_keys, target_record_id::text || ':' || relationship_text
      );

      select edge.to_storage_contract_id, edge.to_record_id into edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = organization_id_value
        and edge.from_storage_contract_id = (subject_meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_subject_record_id;
      -- A relationship the subject has not set has nothing to copy.
      if not found then continue; end if;
      select catalogue_row.record_type_id into edge_type_id
      from vortex_record.storage_catalogue as catalogue_row
      where catalogue_row.storage_contract_id = edge_row.to_storage_contract_id;
      if edge_type_id is null
        or not vortex_record.relationship_declares_target_internal(
          relationship_value, edge_type_id
        ) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_unavailable'
        );
      end if;

      select edge.to_storage_contract_id, edge.to_record_id into existing_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = organization_id_value
        and edge.from_storage_contract_id = (subject_meta ->> 'storageContractId')::uuid
        and edge.from_record_id = target_record_id;
      if found then
        -- Never delete or re-point an existing edge: the same edge is already
        -- the desired state, any other refuses the whole command.
        if existing_row.to_storage_contract_id = edge_row.to_storage_contract_id
          and existing_row.to_record_id = edge_row.to_record_id then
          continue;
        end if;
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_copy_would_replace'
        );
      end if;

      copies := copies || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'targetRecordTypeId', target_type_id,
        'targetRecordId', target_record_id,
        'relationshipId', (relationship_value ->> 'relationshipId')::uuid,
        'fromFieldId', (relationship_value ->> 'fromFieldId')::uuid,
        'value', pg_catalog.jsonb_build_object(
          'recordTypeId', edge_type_id, 'recordId', edge_row.to_record_id
        )
      ));
    end loop;
  end loop;

  -- Every linked row's share lock, in one canonical order, still ahead of
  -- every counter, data version and edge identity (#858).
  for lock_row in
    select distinct
      (copy.value #>> '{value,recordTypeId}')::uuid as record_type_id,
      (copy.value #>> '{value,recordId}')::uuid as record_id
    from pg_catalog.jsonb_array_elements(copies) copy(value)
    order by 1, 2
  loop
    perform vortex_record.lock_relationship_target_row_internal(
      lock_row.record_type_id, lock_row.record_id, organization_id_value
    );
  end loop;

  return pg_catalog.jsonb_build_object('outcome', 'planned', 'copies', copies);
end
$function$;

alter function vortex_record.prepare_named_action_relationship_copies_internal(text,uuid,bigint,uuid,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) to vortex_record_adapter;
comment on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb
) is
  'Private named-action step: re-derives every record.changes task from the installed action its caller resolved and the supplied inputs, locks every target row and then every linked row in canonical order before any counter, data version or edge identity, and plans only the selected, declared, readable many-to-one subject edges the target does not already hold. Returns null when the action has no such task, a refused outcome for a request it cannot honour, and raises only on a broken invariant.';


create or replace function vortex_record.prepare_named_action_set_announce_internal(
  p_preview boolean,
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_activity_id uuid,
  p_read_loaded jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt_claim jsonb;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  projection jsonb;
  copy_plan jsonb;
  copy_targets jsonb := '[]'::jsonb;
  copy_target record;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  record_type_meta jsonb;
  reused_read_facts boolean := false;
begin
  if p_preview is null or p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    -- #571: a deleting action's subject is soft-deleted, so it cannot be
    -- projected; its replay is the delete's own stored outcome.
    if projection ->> 'outcome' <> 'completed' then
      projection := coalesce(
        vortex_record.named_action_deleted_subject_replay_internal(
          p_command_id, p_action_owner_kind, p_action_owner_id,
          p_action_release_revision, p_action_id, p_record_type_id
        ),
        projection
      );
    end if;
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'tasks') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'tasks'
      ) item(value)
      where item.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null, action_context
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- A preview of a record its caller has just read in this invocation reuses
  -- that read's facts when they are exactly the facts the named loader would
  -- build: the record alone, with no inherited owner, no edge and no
  -- relationship route on any of the action's permissions. Only the fixed
  -- record adapter can pass them; the action's own decision is still made below.
  record_type_meta := p_read_loaded -> 'recordTypeMeta';
  if p_preview and p_read_loaded ->> 'outcome' = 'loaded'
    and not (p_read_loaded ? 'previewInstallationId')
    and (p_read_loaded ->> 'isSystemProjection')::boolean is false
    and p_read_loaded -> 'context' = context_value
    and pg_catalog.jsonb_typeof(record_type_meta) = 'object'
    and pg_catalog.lower(record_type_meta ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and coalesce(record_type_meta ->> 'ownershipMode', '') <> 'inherited'
    and p_read_loaded #> '{facts,binding}' = action_context #> '{declaration,recordBinding}'
    and pg_catalog.jsonb_array_length(p_read_loaded #> '{facts,records}') = 1
    and p_read_loaded #>> '{facts,records,0,recordScope,recordId}' = pg_catalog.lower(p_record_id::text)
    and p_read_loaded #> '{facts,edges}' = '[]'::jsonb
    and pg_catalog.jsonb_typeof(action_context #> '{declaration,requiredPermissions}') = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(action_context #> '{declaration,requiredPermissions}') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    loaded := pg_catalog.jsonb_build_object(
      'outcome', 'loaded',
      'declaration', action_context -> 'declaration',
      'facts', p_read_loaded -> 'facts',
      'concurrencyNumber', p_read_loaded -> 'concurrencyNumber',
      'fieldValues', p_read_loaded -> 'fieldValues'
    );
    reused_read_facts := true;
  else
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      case when p_preview then null else p_expected_concurrency_number end
    );
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if p_preview and (loaded ->> 'concurrencyNumber')::bigint <>
      p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- Read facts reused above keep the record types their read decision
  -- validated in this invocation; the named loader's own facts are validated in full.
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts', null,
    case when reused_read_facts then loaded #> '{facts,recordTypes}' end
  );
  if decision ->> 'outcome' <> 'allowed' then
    if p_preview then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
      loaded -> 'facts' -> 'recordTypes', p_record_type_id,
      bounds -> 'readableFieldIds'
    )
  );
  -- Use the same locked copy plan the writer re-derives. Only rows with an
  -- actual new edge are evaluated; a no-op copy does not save its target.
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_inputs, action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  for copy_target in
    select (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.jsonb_object_agg(
        item.value ->> 'fromFieldId', item.value -> 'value'
      ) as submitted_values
    from pg_catalog.jsonb_array_elements(
      coalesce(copy_plan -> 'copies', '[]'::jsonb)
    ) item(value)
    group by 1
    order by 1
  loop
    target_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    target_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', copy_target.record_id, null
    );
    if target_loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_meta -> 'declaration', copy_target.record_id,
      (target_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', target_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if target_decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(copy_target.submitted_values) field_id
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements_text(
          vortex_access.resolve_record_field_bounds_internal(target_decision)
            -> 'changeableFieldIds'
        ) allowed(value)
        where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id)
      )
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    copy_targets := copy_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', copy_target.record_id,
        'existingValues', target_loaded -> 'fieldValues',
        'submittedValues', copy_target.submitted_values
      )
    );
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- #578: the owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType',
          'beforeSaveRules', item.value -> 'beforeSaveRules'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'copyTargets', copy_targets,
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    -- A singleton required permission was decided by the named-action access
    -- check above. The Record port may use it for a choice gated by that exact
    -- permission; a multi-permission declaration grants no such shortcut.
    'singleRequiredPermissionId', case
      when pg_catalog.jsonb_array_length(
        loaded #> '{declaration,requiredPermissions}'
      ) = 1 then loaded #> '{declaration,requiredPermissions,0,permissionId}'
      else 'null'::jsonb
    end,
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb
) is
  'Private named-action preparation: replays or refuses by command receipt, then returns the facts, permission decision and bounds of the exact installed action, writing nothing; a preview may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';


CREATE OR REPLACE FUNCTION vortex_record.prepare_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select vortex_record.prepare_named_action_set_announce_internal(
    false, p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs, p_activity_id, null::jsonb
  )
$$;
alter function vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.prepare_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.prepare_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) TO vortex_runtime;


CREATE OR REPLACE FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select vortex_record.prepare_named_action_set_announce_internal(
    true, p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs, p_activity_id, null::jsonb
  )
$$;
alter function vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) TO vortex_runtime;


create or replace function vortex_record.read_record_with_action_previews(
  p_record_type_id uuid,
  p_record_id uuid,
  p_actions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  read_row record;
  action_item jsonb;
  previews jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_actions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_actions) > 20
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_actions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'activityId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint')
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  -- One exact read decision for the page subject: the projection and the
  -- capabilities vortex_record.read_record_with_capabilities returns, and the
  -- read facts every bound action's preview reuses where they are exactly the
  -- facts its named loader would build. Each action is still decided against
  -- its own declaration; a subject the viewer cannot read previews nothing.
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  if read_row.projection ->> 'outcome' = 'allowed' then
    for action_item in
      select item.value from pg_catalog.jsonb_array_elements(p_actions) with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      previews := previews || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'actionId', action_item -> 'actionId',
        'preview', vortex_record.prepare_named_action_set_announce_internal(
          true, (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
          (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
          (action_item ->> 'actionId')::uuid, p_record_type_id, p_record_id,
          (read_row.projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
          (action_item ->> 'activityId')::uuid, read_row.read_facts
        )
      ));
    end loop;
  end if;
  return pg_catalog.jsonb_build_object(
    'record', read_row.projection,
    'capabilities', case when read_row.projection ->> 'outcome' = 'allowed'
      then vortex_record.read_record_capabilities_internal(
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds
      ) end,
    'previews', previews
  );
end
$function$;

alter function vortex_record.read_record_with_action_previews(uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb) to vortex_runtime;

comment on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb) is
  'Fixed record adapter for a page subject and the named actions its placements are bound to: from one read decision under the caller''s current authority, the readable projection (record) and capabilities vortex_record.read_record_with_capabilities returns, and, only when the record is readable, each action''s preview exactly as vortex_record.preview_named_action_set_announce returns it for the record''s current concurrency number and no inputs (previews, in the order given), writing nothing.';


create or replace function vortex_record.read_record_titles_internal(
  p_record_type_id uuid,
  p_record_ids uuid[],
  p_title_field_id uuid
)
returns table (record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  requested_id uuid;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  chunk_start integer;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[] := array[]::jsonb[];
  decided_decisions jsonb[] := array[]::jsonb[];
  decided_bounds jsonb[] := array[]::jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  readable_values jsonb;
  title_key text := pg_catalog.lower(p_title_field_id::text);
begin
  if p_record_ids is null then
    return;
  end if;

  -- The eligibility is local to this invocation. It narrows work only when the
  -- per-record projection confirms the same declaration and a live deadline.
  if p_record_type_id is not null
    and p_record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid then
    foreach requested_id in array p_record_ids loop
      if requested_id is null
        or requested_id = '00000000-0000-0000-0000-000000000000'::uuid then
        continue;
      end if;
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', requested_id, null
      );
      if loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object'
        and not (loaded ? 'previewInstallationId') then
        page_declaration := loaded -> 'declaration';
        page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
          page_declaration, vortex_access.validated_human_request_context(),
          pg_catalog.clock_timestamp()
        );
        first_loaded_id := requested_id;
        first_loaded := loaded;
        exit;
      end if;
    end loop;
  end if;

  -- The other ids are decided together by the page read pass (#2668), from
  -- the first record's exact facts, in sets of at most 200. The pass returns
  -- only the records it decided; every other id keeps the exact path below.
  if first_loaded is not null then
    select pg_catalog.array_agg(distinct candidate.id)
    into candidate_ids
    from pg_catalog.unnest(p_record_ids) as candidate(id)
    where candidate.id is not null and candidate.id <> first_loaded_id;
  end if;
  if candidate_ids is not null then
    select pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
      page.narrowed
    into page_shared, page_narrowed
    from vortex_record.read_record_page_envelope_internal(p_record_type_id, first_loaded) as page;
    chunk_start := 1;
    while chunk_start <= coalesce(pg_catalog.cardinality(candidate_ids), 0) loop
      select decided_ids || coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
        decided_loaded || coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
        decided_decisions || coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
        decided_bounds || coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
      into decided_ids, decided_loaded, decided_decisions, decided_bounds
      from vortex_record.read_record_page_decisions_internal(
        p_record_type_id, first_loaded, page_declaration, page_eligibility,
        candidate_ids[chunk_start:chunk_start + 199], page_shared -> 'envelope', page_narrowed
      ) as decided;
      chunk_start := chunk_start + 200;
    end loop;
  end if;

  foreach requested_id in array p_record_ids loop
    decided_index := case when requested_id is distinct from first_loaded_id
      then pg_catalog.array_position(decided_ids, requested_id) end;
    select row_projection.* into row_read
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, requested_id, page_declaration, page_eligibility,
      validated_record_types, null::jsonb,
      coalesce(decided_loaded[decided_index],
        case when requested_id = first_loaded_id then first_loaded end),
      decided_decisions[decided_index], decided_bounds[decided_index], page_shared
    ) as row_projection;
    if requested_id = first_loaded_id then
      first_loaded := null;
    end if;
    projection := row_read.projection;
    -- Only the exact evaluator validates record types for reuse.
    if validated_record_types is null and decided_index is null then
      validated_record_types := coalesce(
        row_read.read_facts -> 'validatedRecordTypes',
        case when projection ->> 'outcome' = 'allowed'
          then row_read.read_facts #> '{facts,recordTypes}' end
      );
    end if;

    record_id := requested_id;
    if projection ->> 'outcome' = 'allowed' then
      readable_values := projection -> 'values';
      result := (projection - 'values') || pg_catalog.jsonb_build_object(
        'values', case when readable_values ? title_key
          then pg_catalog.jsonb_build_object(title_key, readable_values -> title_key)
          else '{}'::jsonb end
      );
    else
      result := projection;
    end if;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_titles_internal(uuid,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_titles_internal(uuid,uuid[],uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_titles_internal(uuid,uuid[],uuid) to vortex_owner;

comment on function vortex_record.read_record_titles_internal(uuid,uuid[],uuid) is
  'Private adapter batch of record titles: the first record is decided exactly, the others together by the page read pass with a local page eligibility, and any record the pass does not decide (missing, inaccessible, preview or relationship-routed) by the exact single-record path with the same refusal.';


create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  event_loaded jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  public_created_records jsonb := '{}'::jsonb;
  created_record_tuples jsonb := '[]'::jsonb;
  first_created_record_tuples jsonb := '[]'::jsonb;
  inserted_value jsonb;
  final_created_tuple jsonb;
  saved_tuple jsonb;
  seen_created_ordinals integer[] := array[]::integer[];
  seen_created_ids uuid[] := array[]::uuid[];
  created_ordinal integer;
  created_concurrency_number bigint;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  copy_plan jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  person_account_id uuid;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
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
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_rows integer;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership', 'settings')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- A lifecycle command is the terminal delete, restore or ownership transfer.
  -- Delete and restore reach here only after their protected preflight has
  -- already run and claimed the record_lifecycle receipt; this operation owns
  -- the one terminal write and completes it. The request role reaches these
  -- branches only through apply_lifecycle_record_changes: a lifecycle command
  -- carries no submitted values, selected group or action, so the named-action
  -- entry can never reach a lifecycle write under an action identity.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
  end if;

  -- Settings use the same command entry and one settings mutation. Their
  -- physical row belongs to Identity, so the protected implementation below
  -- performs the specialised write and the common Record effects once.
  if p_operation = 'settings' then
    if p_action is not null
      or p_selected_group_id is not null
      or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or (p_mutations -> 0 ->> 'kind') is distinct from 'settings'
      or (p_mutations -> 0) - array['kind', 'values']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'values') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_settings_record_changes_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values,
      p_mutations -> 0 -> 'values', p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
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
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations, action_context
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed Rule the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
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
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
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

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
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
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
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
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs, action_context
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
      or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'completed'
    );
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
  else
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' = 'link_to_person'
      and pg_catalog.jsonb_typeof(entry_value) <> 'null' then
      if not vortex_record.canonical_record_value_matches(entry_value, 'link_to_person', 'json') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'person_reference_unavailable', 'fieldId', entry_key
        );
      end if;
      person_account_id := (entry_value ->> 'organizationAccountId')::uuid;
      if coalesce(field_value #>> '{settings,audience}', '') not in (
          'organization_accounts', 'application_accounts',
          'organization_identities_and_external_requesters'
        )
        or not vortex_access.lock_active_record_ownership_target_internal(
          'organization_account', person_account_id
        )
        or ((field_value #>> '{settings,audience}' = 'application_accounts'
            or coalesce((field_value #>> '{settings,applicationRootIdRequired}')::boolean, false))
          and not vortex_access.organization_account_has_current_application_access_internal(
            organization_id_value, person_account_id, application_root_id_value
          )) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'person_reference_unavailable', 'fieldId', entry_key
        );
      end if;
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
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
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
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
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
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if preview_installation is not null
    and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
    perform vortex_record.release_command_receipt_internal(
      receipt_kind, effective_command_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_relationship_refused'
    );
  end if;

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
      );
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
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
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
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
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
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
        );
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
    -- target row locks in one place replaces the per-writer #858 corrections.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

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
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    elsif not action_mode
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    elsif action_mode
      and p_operation = 'update'
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0
      and creation_count = 0
      and pg_catalog.jsonb_typeof(action_parents) = 'array'
      and pg_catalog.jsonb_array_length(action_parents) = 0
      and (case
        when copy_plan is null then true
        when pg_catalog.jsonb_typeof(copy_plan) = 'object'
          and copy_plan ->> 'outcome' = 'planned'
          and pg_catalog.jsonb_typeof(copy_plan -> 'copies') = 'array'
          then pg_catalog.jsonb_array_length(copy_plan -> 'copies') = 0
        else false
      end)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
        where task.value ->> 'type' = 'record.delete'
      ) then
      -- The named declaration and proposed graph already passed their protected
      -- decisions and target locks. Save one actual subject tuple before edges.
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
           definition_revision = $4
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number',
        loaded ->> 'table'
      ) into saved_record_id, saved_concurrency_number
      using organization_id_value, p_record_id, actor_id_value,
        (loaded ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
      get diagnostics changed_rows = row_count;
      if changed_rows <> 1 then
        raise exception using errcode = '40001',
          message = 'Named relationship change did not apply to exactly one row';
      end if;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named relationship saved identity is unavailable';
      end if;
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', saved_record_id,
        'concurrencyNumber', saved_concurrency_number
      );
      named_relationship_subject_saved := true;
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
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  perform vortex_record.mirror_person_links_internal(
    (meta ->> 'storageContractId')::uuid, organization_id_value,
    saved_record_id, final_values
  );
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_named_action_activity_internal(
      p_activity_id, saved_record_id, changed_field_ids, 'completed'
    );
  elsif preview_installation is null then
    activity_time := vortex_record.append_base_save_activity_internal(
      p_activity_id, p_operation, saved_record_id,
      changed_field_ids, 'completed'
    );
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_platform.append_record_occurrences(
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
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := vortex_record.read_record(p_record_type_id, saved_record_id);
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      perform vortex_record.mirror_person_links_internal(
        (inserted_value ->> 'storageContractId')::uuid, organization_id_value,
        (inserted_value ->> 'recordId')::uuid, inserted_value -> 'values'
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- Reauthorize the complete new graph before any created-row Activity or
    -- Event is visible. This barrier is intentionally whole-command, not per row.
    first_created_record_tuples :=
      vortex_record.authorize_created_records_for_command_internal(
        action_creations, created_records, original_context_value
      );
    if pg_catalog.jsonb_typeof(first_created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(first_created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;

    -- Append each created-row Activity and its standard Event only after the
    -- complete set passed ordinary CREATE authorization.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_typeof(event_result -> 0) is distinct from 'object'
        or event_result -> 0 ->> 'occurrenceId' is distinct from occurrence_id_value::text then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
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

  if creation_count > 0 then
    -- Re-load and reauthorize the entire graph after every mandatory created-row,
    -- copy and parent effect. These actual final target tuples drive both receipt
    -- completion and the narrow advisory created-notice attempts below.
    created_record_tuples := vortex_record.authorize_created_records_for_command_internal(
      action_creations, created_records, original_context_value
    );
    if pg_catalog.jsonb_typeof(created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    for final_created_tuple in
      select item.value
      from pg_catalog.jsonb_array_elements(created_record_tuples) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(final_created_tuple) is distinct from 'object'
        or not (final_created_tuple ?& array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ])
        or final_created_tuple - array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ]::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'ordinal') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'ordinal', 'integer'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'concurrencyNumber') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'concurrencyNumber', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'organizationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'organizationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') not in ('string', 'null')
        or (pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') = 'string'
          and coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'applicationRootId', 'uuid'), true))
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleRootId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleRootId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordTypeId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordTypeId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageContractId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'storageContractId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleReleaseRevision') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageScope') is distinct from 'string'
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'correlationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'correlationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'eligible') is distinct from 'boolean' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is malformed';
      end if;
      created_ordinal := (final_created_tuple ->> 'ordinal')::integer;
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      if created_ordinal < 0
        or created_ordinal = any (seen_created_ordinals)
        or created_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or created_record_id = any (seen_created_ids)
        or created_concurrency_number not between 1 and 9007199254740991
        or (final_created_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or (final_created_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
        or (final_created_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
        or (final_created_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
        or ((final_created_tuple ->> 'storageScope') = 'application_contained'
          and (final_created_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
        or ((final_created_tuple ->> 'storageScope') = 'organization_shared'
          and final_created_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
        or (final_created_tuple ->> 'eligible')::boolean is distinct from
          ((final_created_tuple ->> 'storageScope') = 'application_contained') then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is invalid';
      end if;
      inserted_value := created_records -> created_ordinal::text;
      saved_tuple := inserted_value -> '_savedTuple';
      if inserted_value is null
        or final_created_tuple -> 'recordId' is distinct from inserted_value -> 'recordId'
        or final_created_tuple -> 'organizationId' is distinct from saved_tuple -> 'organizationId'
        or final_created_tuple -> 'applicationRootId' is distinct from saved_tuple -> 'applicationRootId'
        or final_created_tuple -> 'moduleRootId' is distinct from saved_tuple -> 'moduleRootId'
        or final_created_tuple -> 'recordTypeId' is distinct from saved_tuple -> 'recordTypeId'
        or final_created_tuple -> 'storageContractId' is distinct from saved_tuple -> 'storageContractId'
        or final_created_tuple -> 'moduleReleaseRevision' is distinct from saved_tuple -> 'moduleReleaseRevision'
        or final_created_tuple -> 'storageScope' is distinct from saved_tuple -> 'storageScope'
        or final_created_tuple -> 'correlationId' is distinct from saved_tuple -> 'correlationId'
        or final_created_tuple -> 'eligible' is distinct from saved_tuple -> 'eligible' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple changed';
      end if;
      seen_created_ordinals := pg_catalog.array_append(seen_created_ordinals, created_ordinal);
      seen_created_ids := pg_catalog.array_append(seen_created_ids, created_record_id);
      public_created_records := public_created_records || pg_catalog.jsonb_build_object(
        created_ordinal::text, pg_catalog.jsonb_build_object(
          'recordId', inserted_value -> 'recordId',
          'storageContractId', inserted_value -> 'storageContractId',
          'values', inserted_value -> 'values'
        )
      );
    end loop;
    if pg_catalog.cardinality(seen_created_ordinals) <> creation_count
      or pg_catalog.cardinality(seen_created_ids) <> creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation set is incomplete';
    end if;

    if not named_action_receipt_pending then
      raise exception using errcode = '55000',
        message = 'Named action receipt completion is unavailable';
    end if;
    if named_action_receipt_subject_write then
      if saved_record_id is null
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named action receipt completion tuple is unavailable';
      end if;
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, saved_record_id, saved_concurrency_number,
        'Record save receipt is stale'
      );
    else
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    end if;
    named_action_receipt_pending := false;
  end if;

  -- Only the new created-row notice attempt is advisory. All tuple and context
  -- validation above is outside this per-tuple catch; allocation, safe sequence
  -- validation and exact publication share one narrow failure boundary.
  for final_created_tuple in
    select item.value from pg_catalog.jsonb_array_elements(created_record_tuples) item(value)
  loop
    if (final_created_tuple ->> 'eligible')::boolean then
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Created Record notice sequence is unavailable';
        end if;
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value,
          (final_created_tuple ->> 'recordTypeId')::uuid,
          created_record_id, created_concurrency_number, 'created',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  if named_relationship_subject_saved then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        organization_id_value, application_root_id_value, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Invalidation is advisory after the protected named action is complete.
      null;
    end;
  end if;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', public_created_records);
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one command receipt (a preview command carries its own preview-scoped id) and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';


create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb,
  p_direction text,
  p_exact_record_id uuid
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
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_source_sql text;
  scan_projection_sql text := 'null::jsonb';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_batch jsonb;
  projection_after jsonb; projection_batch_size integer;
  projection_candidate_count integer := 0; projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  page_first_loaded jsonb;
  -- What every row of the page shares, built once in this invocation: the
  -- validated active installation, the facts envelope and the read-time inputs.
  page_shared jsonb; page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  first_returned_sort_key text[];
  first_returned_record_id uuid;
  next_value jsonb := null;
  opposite_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  -- Every board column this call reads: one for a member page, every displayed
  -- column for a board's first pages, each read in its own pass below.
  board_columns_mode boolean := false;
  board_columns jsonb := '[]'::jsonb;
  board_column_item jsonb;
  board_column_position integer := 0;
  board_column_pages jsonb := '[]'::jsonb;
  -- The stored choice column, when the reader is guaranteed to see the choice
  -- field on every scanned row, and the current column's candidate predicate.
  board_choice_column text;
  board_scan_sql text := '';
  group_member jsonb;
  group_selector jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_field_type text;
  group_member_matches boolean;
  preview_mode boolean := false;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
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
  -- User-facing sort and search, plus the user filter passed to shared
  -- preparation. The component's declared field sets only narrow user input;
  -- they never supply authority or replace the published query contract.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  board_columns_mode := p_user_inputs ? 'boardColumns';
  group_member_mode := p_user_inputs ? 'groupMember';
  if (board_member_mode and group_member_mode)
    or (board_columns_mode and (board_member_mode or group_member_mode)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- A board's first pages: every requested column, each from its start.
  if board_columns_mode and (p_direction <> 'forward' or p_exact_record_id is not null
    or (p_after is not null and p_after <> 'null'::jsonb)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := board_member_mode or board_columns_mode;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'boardColumns', 'groupMember'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := vortex_record.group_member_selector_internal(p_user_inputs -> 'groupMember');
    if group_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := p_user_inputs #> '{groupMember,values}';
    group_selector_types := group_member -> 'types';
    group_selector_values := group_member -> 'values';
  end if;
  if board_member_mode then
    board_member := vortex_record.board_column_selector_internal(
      p_user_inputs -> case when board_columns_mode then 'boardColumns' else 'boardMember' end,
      board_columns_mode
    );
    if board_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := board_member ->> 'choiceFieldId';
    board_columns := board_member -> 'columns';
  end if;
  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);
  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);
  -- An exact record id resolves one identity; the search only narrows pages of a list, so it is
  -- ignored here while the published filter and the viewer's authority still apply unchanged.
  if p_exact_record_id is not null then
    user_search := null;
    user_search_folded := null;
  end if;
  if (board_member_mode or group_member_mode) and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    or user_search is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
    or (group_member_mode and p_user_inputs ? 'search'
      and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') is distinct from 'null')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if p_exact_record_id is not null and (preview_mode or record_type_item ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if preview_mode and (
    board_member_mode or group_member_mode or pg_catalog.cardinality(system_field_keys) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;
  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    if pg_catalog.jsonb_array_length(query_item -> 'groupByFieldIds') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(query_item -> 'groupByFieldIds') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) is distinct from 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = '00000000-0000-0000-0000-000000000000' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_key := pg_catalog.lower(field_item #>> '{}');
      group_field_type := coalesce(fields_by_id -> group_key ->> 'type', '');
      if group_key = any (group_by_ids)
        or group_field_type not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several', 'link_to_person'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_by_ids := pg_catalog.array_append(group_by_ids, group_key);
    end loop;
    if pg_catalog.jsonb_array_length(group_selector) <> pg_catalog.cardinality(group_by_ids)
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(group_selector_types) as supplied(key)
        where supplied.key <> all (group_by_ids)
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    foreach group_key in array group_by_ids loop
      if group_selector_types ->> group_key is distinct from fields_by_id -> group_key ->> 'type' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
    end loop;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;
  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(board_columns) as requested(value)
      where requested.value ->> 'kind' = 'option'
        and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    -- A column reads only its own cards. When the reader is guaranteed to see the
    -- choice field on every row the scan examines, the stored choice value is the
    -- readable value, so the column's membership narrows the candidate scan and the
    -- budget is spent on that column's members only. Otherwise the scan stays
    -- unnarrowed and membership is decided from each readable projection below, so
    -- a withheld value never decides which rows are examined.
    if board_choice_field_id = any (readable_field_ids) then
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = board_choice_field_id::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if mapping_row.database_value_type = 'text' then
        board_choice_column := mapping_row.physical_column_token;
      end if;
    end if;
  end if;
  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if board_member_mode or group_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 0 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;
  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);
  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
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
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;
  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when p_direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when p_direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;
  scan_source_sql := pg_catalog.format('record_data.%I as stored', physical_table_token);
  projection_page_scan := not preview_mode and record_type_item ? 'systemProjection'
    and coalesce(p_user_inputs -> 'filter', 'null'::jsonb) = 'null'::jsonb
    and coalesce(query_item -> 'filter', 'null'::jsonb) = 'null'::jsonb
    and user_search is null
    and not board_member_mode and not group_member_mode
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and vortex_record.has_bounded_system_projection_reader_internal(
      v_storage_contract_id, fields_by_id -> sort_ids[1] ->> 'key'
    );
  if projection_page_scan then
      projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
      if projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is unavailable';
      end if;
      projection_after := p_after;
      projection_batch_size := least(p_page_size + 1, scan_limit);
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        null::uuid[], projection_sort_key, scan_directions[1], projection_after,
        projection_batch_size) with ordinality as projected(organization_id, record_id,
        revision, attribute_values, ordinality);
  end if;
  if projection_page_scan then
      -- The registered view contributes its row type only. The bounded reader
      -- supplies every candidate, including rows later rejected by the query.
      scan_source_sql := pg_catalog.format($source$
        pg_catalog.jsonb_to_recordset($11) as projection(
          organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
        )
        cross join lateral pg_catalog.jsonb_populate_record(
          null::record_data.%I,
          pg_catalog.jsonb_build_object(
            'organisation_id', projection.organization_id,
            'module_root_id', %L::uuid,
            'record_type_id', %L::uuid,
            'storage_contract_id', %L::uuid,
            'record_id', projection.record_id,
            'definition_revision', %L::bigint,
            'lifecycle_state', 'active',
            'concurrency_number', projection.revision
          ) || coalesce((
            select pg_catalog.jsonb_object_agg(
              'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
              case
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.organization_id::text)
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.revision)
                else projection.attribute_values -> (field.value ->> 'key')
              end
            )
            from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
          ), '{}'::jsonb)
        ) as stored$source$,
        physical_table_token, p_module_root_id, record_type_id_value,
        v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
        record_type_item #>> '{systemProjection,organizationFieldId}',
        record_type_item #>> '{systemProjection,revisionFieldId}',
        record_type_item
      );
      scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;
  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);
    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;
  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;
  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  end if;
  -- One pass per requested board column, each with its own page, budget and
  -- position; every other read makes exactly one pass. The page's access facts,
  -- eligibility and validated record types stay those of this one invocation.
  <<column_pass>>
  loop
  if board_member_mode then
    board_column_position := board_column_position + 1;
    exit column_pass when board_column_position > pg_catalog.jsonb_array_length(board_columns);
    board_column_item := board_columns -> (board_column_position - 1);
    board_column_kind := board_column_item ->> 'kind';
    board_column_value := board_column_item ->> 'value';
    board_scan_sql := case
      when board_choice_column is null then ''
      when board_column_kind = 'option' then pg_catalog.format(
        ' and stored.%I collate "C" = $13 collate "C"', board_choice_column)
      else pg_catalog.format(
        ' and (stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
        board_choice_column)
    end;
    if board_column_position > 1 then
      examined := 0;
      budget_exhausted := false;
      more_rows := false;
      rows_value := '[]'::jsonb;
      row_count := 0;
      capability_rows := array[]::jsonb[];
      decided_ids := array[]::uuid[];
      decided_loaded := null;
      decided_decisions := null;
      decided_bounds := null;
      last_examined_sort_key := null;
      last_examined_record_id := null;
      last_returned_sort_key := null;
      last_returned_record_id := null;
      first_returned_sort_key := null;
      first_returned_record_id := null;
      next_value := null;
      opposite_value := null;
    end if;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12 is null or stored.record_id = $12)
       and %s
       and (%s)
        and (case when (%s) then true else false end)%s%s
     order by %s
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
    scan_projection_sql,
    scan_source_sql,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    board_scan_sql,
    segment_sql,
    order_by_sql
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters, projection_batch, p_exact_record_id,
      board_column_value, board_option_values;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
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
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
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
      page_access_loaded := null;
      if not preview_mode and not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        page_shared := pg_catalog.jsonb_build_object(
          'installation', vortex_definition.read_current_active_installation());
        page_access_loaded := vortex_record.load_record_access_facts_from_installation_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= p_page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(declared_sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, readable_values -> grouped.id)
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          if row_count = 0 then
            first_returned_sort_key := scan_record.sort_key;
            first_returned_record_id := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          row_count := row_count + 1;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or more_rows or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(p_page_size + 1, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, scan_directions[1], projection_after,
    projection_batch_size) with ordinality as projected(organization_id, record_id,
    revision, attribute_values, ordinality);
  end loop;
  exit when more_rows or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not more_rows then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows), page_shared -> 'envelope'
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
      raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
    end if;
    -- Each row gets its own capabilities, in one pass over the page.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;
  if first_returned_record_id is not null then
    opposite_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(first_returned_sort_key),
      'phase', case when pg_catalog.cardinality(first_returned_sort_key) > 0
        and first_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', first_returned_record_id
    );
  end if;
  if p_direction = 'backward' and row_count > 1 then
    select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  exit column_pass when not board_columns_mode;
  board_column_pages := board_column_pages || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('column', board_column_item, 'rows', rows_value, 'next', next_value)
  );
  end loop column_pass;
  if board_columns_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'columns', board_column_pages
    );
  end if;
  if group_member_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
      'groupValues', group_selector_values,
      'rows', rows_value,
      'next', next_value
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value,
    'opposite', opposite_value
  );
end
$function$;
alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid)
  to vortex_request;
comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, reads one column''s member page or, for a board''s first pages, the first page of every requested column in one invocation with its own budget and position per column, classifies those columns from current readable values and, when the choice field is guaranteed readable on every scanned row, narrows each column''s candidate scan to its own stored choice value so a column reads only its own cards, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values or affects scan order or budget; orders board and generic group pages by record identity, returns generic group identity even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; refuses preview member, grouped, aggregate and system projection modes.';

drop function vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb);
drop function vortex_record.prepare_named_action_relationship_copies_internal(text,uuid,bigint,uuid,uuid,uuid,jsonb);
drop function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid);

drop function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb);
drop function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text);

set local role vortex_owner;

reset role;
