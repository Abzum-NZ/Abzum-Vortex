set role vortex_owner;

create or replace function vortex_record.installed_record_type_action_contributions_internal(
  p_organization_id uuid,
  p_target_module_root_id uuid,
  p_target_module_release_revision bigint,
  p_target_record_type_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  target_content jsonb;
  target_storage_contract_id uuid;
  field_contributions jsonb;
  contributor record;
  contributor_content jsonb;
  contribution jsonb;
  point jsonb;
  action_definition jsonb;
  action_flow jsonb;
  contributed_field_ids text[];
  result jsonb := '[]'::jsonb;
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_target_module_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or p_target_module_release_revision is null
    or p_target_module_release_revision not between 1 and 9007199254740991
    or p_target_record_type_id is null
    or not vortex_platform.is_non_nil_uuid(p_target_record_type_id::text) then
    raise exception using errcode = '22023',
      message = 'Installed contribution selector is invalid';
  end if;

  -- The owner Module release the calling application binds declares the extension points a
  -- contribution must resolve against; it counts only while the organisation actively binds it.
  select release.compilation_output #> '{canonical,content}' into target_content
  from vortex_definition.releases as release
  where release.root_id = p_target_module_root_id
    and release.release_revision = p_target_module_release_revision
    and exists (
      select 1
      from vortex_definition.installation_bindings as binding
      where binding.organization_id = p_organization_id
        and binding.module_root_id = p_target_module_root_id
        and binding.module_release_revision = p_target_module_release_revision
        and binding.state = 'active'
    );
  if target_content is null then
    return result;
  end if;
  select (record_type.value ->> 'storageContractId')::uuid into target_storage_contract_id
  from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as record_type(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId')
    = pg_catalog.lower(p_target_record_type_id::text)
    and not record_type.value ? 'systemProjection';
  if target_storage_contract_id is null then
    return result;
  end if;
  -- The fields contributed to this record type, resolved once for every contributor below.
  field_contributions := vortex_record.installed_record_type_contributions_internal(
    p_organization_id, p_target_module_root_id, target_storage_contract_id
  );

  -- Only Modules that depend on the owner can contribute to it, so only their releases are read.
  for contributor in
    select binding.module_root_id,
      pg_catalog.max(binding.module_release_revision) as release_revision,
      pg_catalog.jsonb_agg(distinct binding.application_root_id) as application_root_ids
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.state = 'active'
      and binding.module_root_id <> p_target_module_root_id
      and exists (
        select 1
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = binding.module_root_id
          and dependency.release_revision = binding.module_release_revision
          and dependency.dependency_kind = 'module'
          and dependency.target_root_id = p_target_module_root_id
      )
    group by binding.module_root_id
    order by binding.module_root_id
  loop
    select release.compilation_output #> '{canonical,content}' into contributor_content
    from vortex_definition.releases as release
    where release.root_id = contributor.module_root_id
      and release.release_revision = contributor.release_revision;
    if contributor_content is null then
      continue;
    end if;
    select coalesce(pg_catalog.array_agg(pg_catalog.lower(field_entry.value ->> 'contributionId')), array[]::text[])
    into contributed_field_ids
    from pg_catalog.jsonb_array_elements(field_contributions) as field_entry(value)
    where (field_entry.value ->> 'contributorModuleRootId')::uuid = contributor.module_root_id;

    for contribution in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(contributor_content -> 'contributions', '[]'::jsonb))
        as item(value)
      where item.value ->> 'kind' = 'action'
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(p_target_module_root_id::text)
    loop
      select extension_point.value into point
      from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as extension_point(value)
      where pg_catalog.lower(extension_point.value ->> 'extensionPointId')
        = pg_catalog.lower(contribution ->> 'targetExtensionPointId');
      if point is null
        or pg_catalog.lower(point ->> 'recordTypeId') <> pg_catalog.lower(p_target_record_type_id::text)
        or not (point -> 'accepts') ? 'action' then
        continue;
      end if;
      select action.value into action_definition
      from pg_catalog.jsonb_array_elements(contributor_content -> 'actions') as action(value)
      where pg_catalog.lower(action.value ->> 'actionId') = pg_catalog.lower(contribution ->> 'actionId');
      if action_definition is null then
        continue;
      end if;
      -- The action's behaviour is its transaction flow, which the record service runs.
      select flow.value into action_flow
      from pg_catalog.jsonb_array_elements(coalesce(contributor_content -> 'flows', '[]'::jsonb)) as flow(value)
      where pg_catalog.lower(flow.value ->> 'id') = pg_catalog.lower(action_definition ->> 'flowId')
        and flow.value ->> 'execution' = 'transaction';
      if action_flow is null then
        continue;
      end if;
      -- A contributed action is a plain value change: it takes no inputs, its flow only sets
      -- fields (no delete, creation, copy or Event), and it sets only fields its own Module
      -- contributed to this record type. Anything else would act on the owner's record beyond
      -- what the owner admitted.
      if pg_catalog.jsonb_array_length(coalesce(action_definition -> 'inputs', '[]'::jsonb)) <> 0
        or pg_catalog.jsonb_typeof(action_definition -> 'writePolicy') is distinct from 'object'
        or pg_catalog.jsonb_array_length(action_definition #> '{writePolicy,subjectFieldIds}') = 0
        or (action_definition #>> '{writePolicy,deletesSubject}')::boolean
        or pg_catalog.jsonb_array_length(action_definition #> '{writePolicy,creates}') <> 0
        or pg_catalog.jsonb_array_length(action_definition #> '{writePolicy,relationshipCopies}') <> 0
        or pg_catalog.jsonb_array_length(action_definition #> '{writePolicy,eventKeys}') <> 0
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(action_definition #> '{writePolicy,subjectFieldIds}') as set_key(value)
          where pg_catalog.lower(set_key.value) <> all (contributed_field_ids)
        ) then
        continue;
      end if;
      result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'action',
        'contributionId', contribution ->> 'actionId',
        'extensionPointId', contribution ->> 'targetExtensionPointId',
        'contributorModuleRootId', contributor.module_root_id,
        'contributorReleaseRevision', contributor.release_revision,
        'contributorApplicationRootIds', contributor.application_root_ids,
        'action', action_definition,
        'flow', action_flow
      ));
    end loop;
  end loop;
  return result;
end
$function$;

alter function vortex_record.installed_record_type_action_contributions_internal(uuid,uuid,bigint,uuid) owner to vortex_owner;

revoke all on function vortex_record.installed_record_type_action_contributions_internal(uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_record_type_action_contributions_internal(uuid, uuid, bigint, uuid)
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_record_type_action_contributions_internal(uuid, uuid, bigint, uuid) is
  'Private exact installed action contributions of one owner record type in one organisation: the contributor Module''s declared actions, resolved against the extension point of the exact owner release the calling application binds, that take no inputs and only set fields the contributor itself contributed to that record type. Owner-only except for the fixed record adapter; it decides no access.';

set role vortex_record_adapter;

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

  -- A create-bearing command may also change the subject's own links.
  -- The inversion this used to guard against (the subject's relationship edge
  -- identities L6 before a created record's reference-number counter L4 and
  -- data version) is closed by the terminal writer, which reserves every
  -- creation's counters and every affected data version before the subject
  -- writer runs.

  -- The creations the action may make are the write policy derived from its flow, in flow order.
  for task_value, task_ordinal in
    select pg_catalog.jsonb_build_object(
        'recordTypeId', item.value -> 'recordTypeId',
        'values', coalesce((
          select pg_catalog.jsonb_object_agg(field.value, 'null'::jsonb)
          from pg_catalog.jsonb_array_elements_text(item.value -> 'fieldIds') as field(value)
        ), '{}'::jsonb)
      ), (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(
      coalesce(action_context #> '{action,writePolicy,creates}', '[]'::jsonb)
    ) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if not pg_catalog.pg_input_is_valid(task_value ->> 'recordTypeId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    target_type_id := (task_value ->> 'recordTypeId')::uuid;
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
      if not (task_value -> 'values') ? ownership_field_id then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
        );
      end if;
    end if;

    for field_key in
      select pg_catalog.lower(item.value)
      from pg_catalog.jsonb_object_keys(task_value -> 'values') item(value)
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
        'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
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
          from pg_catalog.jsonb_object_keys(task_value -> 'values') item(value)
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
  if pg_catalog.jsonb_array_length(
    coalesce(action_context #> '{action,writePolicy,relationshipCopies}', '[]'::jsonb)
  ) = 0 then
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
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_subject_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  readable_field_ids := vortex_record.decide_record_field_bounds_internal(decision)
    -> 'readableFieldIds';
  if pg_catalog.jsonb_typeof(readable_field_ids) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'Relationship copy field bounds are unavailable';
  end if;

  -- Discover every target and copy first, then lock: a target row lock is the
  -- first lock class, so it is taken as soon as the target is known.
  for change_value, task_ordinal in
    select change.value, change.ordinality
    from pg_catalog.jsonb_array_elements(action_context #> '{action,writePolicy,relationshipCopies}')
      with ordinality as change(value, ordinality)
    order by change.ordinality
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
        -- writes the subject, so the action's flow may not also set that same link.
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(
            action_context #> '{action,writePolicy,subjectFieldIds}'
          ) as key(field_key)
          where pg_catalog.lower(key.field_key) =
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
  -- every counter, data version and edge identity.
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

create or replace function vortex_record.prepare_named_action_subject_internal(
  p_preview boolean,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_read_loaded jsonb,
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
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  copy_plan jsonb;
  copy_targets jsonb := '[]'::jsonb;
  copy_target record;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  record_type_meta jsonb;
  reused_read_facts boolean := false;
begin
  if p_preview is null or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- The context depends only on the action and the record type: a page that previews
  -- one action for many records resolves it once and passes it here; null resolves it now.
  action_context := coalesce(p_action_context, vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  ));
  if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'writePolicy') is distinct from 'object' then
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
    return pg_catalog.jsonb_build_object(
      'outcome', 'subject_permission_refused', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
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
    target_loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', copy_target.record_id
      ))
    ) -> 0);
    if target_loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', target_meta -> 'declaration',
        'recordId', copy_target.record_id,
        'facts', (target_loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', target_meta -> 'declaration' -> 'recordBinding' )
      )
    )) -> 0);
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
          vortex_record.decide_record_field_bounds_internal(target_decision)
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
        'concurrencyNumber', target_loaded -> 'concurrencyNumber',
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
    -- The owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
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
          'beforeSaveFlows', item.value -> 'beforeSaveFlows'
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
end
$function$;
alter function vortex_record.prepare_named_action_subject_internal(boolean,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_action_subject_internal(boolean,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_subject_internal(boolean,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) is
  'Private named-action subject preparation shared by preview and command execution: resolves current action authority, locked facts, creation metadata and relationship copies without reading or writing a command receipt or Activity.';

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
  copy_plan jsonb;
  creation_plan jsonb;
  subject jsonb;
  subject_index integer;
  expected_fields jsonb;
  supplied_fields jsonb;
  root_fields jsonb;
  root_delete boolean;
  root_seen boolean := false;
  creation_tasks jsonb;
  creation_index integer := 0;
  creation_task jsonb;
  creations jsonb := '[]'::jsonb;
  copy_values jsonb;
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
  if pg_catalog.jsonb_typeof(action_context #> '{action,writePolicy}') is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  -- What the action may write is the write policy derived from its published flow.
  select coalesce(pg_catalog.jsonb_agg(distinct field.key order by field.key), '[]'::jsonb)
  into root_fields
  from pg_catalog.jsonb_array_elements_text(action_context #> '{action,writePolicy,subjectFieldIds}') as field(key);
  root_delete := (action_context #>> '{action,writePolicy,deletesSubject}')::boolean;
  if root_delete and pg_catalog.jsonb_array_length(root_fields) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  select coalesce(pg_catalog.jsonb_agg(task.value || pg_catalog.jsonb_build_object('ordinal', task.ordinality - 1)
    order by task.ordinality), '[]'::jsonb) into creation_tasks
  from pg_catalog.jsonb_array_elements(action_context #> '{action,writePolicy,creates}') with ordinality as task(value, ordinality);
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, (p_named_action ->> 'recordId')::uuid,
    p_named_action -> 'inputs', action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then return copy_plan; end if;

  -- The four-intent shape stays unchanged. The exact installed action bounds which
  -- subject, creation and copy each intent represents; derived parents come from the graph.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
    into supplied_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key);
    if subject ->> 'operation' = 'create' then
      creation_task := creation_tasks -> creation_index;
      if creation_task is null or subject -> 'recordTypeId' is distinct from creation_task -> 'recordTypeId'
        or subject -> 'selectedGroupId' is distinct from 'null'::jsonb then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
      into expected_fields from pg_catalog.jsonb_array_elements_text(creation_task -> 'fieldIds') as field(key);
      if supplied_fields is distinct from expected_fields then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      creations := creations || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', creation_task -> 'ordinal', 'recordTypeId', subject -> 'recordTypeId',
        'values', subject -> 'submittedValues', 'finalValues', subject -> 'finalValues'
      ));
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'creation');
      creation_index := creation_index + 1;
    elsif subject -> 'recordTypeId' = p_named_action -> 'recordTypeId'
      and subject -> 'recordId' = p_named_action -> 'recordId' then
      if root_seen or subject -> 'expectedConcurrencyNumber' is distinct from p_named_action -> 'expectedConcurrencyNumber'
        or (root_delete and subject ->> 'operation' <> 'delete')
        or (not root_delete and (subject ->> 'operation' <> 'update' or pg_catalog.jsonb_array_length(root_fields) = 0))
        or supplied_fields is distinct from root_fields then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_subject_mismatch');
      end if;
      root_seen := true;
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'subject');
    else
      select pg_catalog.jsonb_object_agg(copy.value ->> 'fromFieldId', copy.value -> 'value')
      into copy_values from pg_catalog.jsonb_array_elements(coalesce(copy_plan -> 'copies', '[]'::jsonb)) as copy(value)
      where copy.value -> 'targetRecordId' = subject -> 'recordId';
      if subject ->> 'operation' <> 'update' or subject -> 'recordTypeId' is distinct from p_named_action -> 'recordTypeId'
        or copy_values is null or subject -> 'submittedValues' is distinct from copy_values
        or (subject ->> 'recordId')::uuid = any(copied_targets) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_copy_plan_mismatch');
      end if;
      copied_targets := pg_catalog.array_append(copied_targets, (subject ->> 'recordId')::uuid);
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'copy');
    end if;
  end loop;
  if root_seen is distinct from (root_delete or pg_catalog.jsonb_array_length(root_fields) > 0)
    or creation_index <> pg_catalog.jsonb_array_length(creation_tasks)
    or exists (select 1 from pg_catalog.jsonb_array_elements(coalesce(copy_plan -> 'copies', '[]'::jsonb)) as copy(value)
      where not ((copy.value ->> 'targetRecordId')::uuid = any(copied_targets))) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_missing');
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, creations, action_context
  );
  if creation_plan ->> 'outcome' is distinct from 'planned' then return creation_plan; end if;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'actionContext', action_context,
    'loaded', loaded, 'bounds', bounds, 'intentRoles', roles, 'createTargets', creation_plan -> 'createTargets');
end
$function$;

alter function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) is
  'Private named-command authority and intent scope: verifies the exact installed action, current subject permission and revision, declared creates, exact relationship copies and optional subject delete before the common record writer prepares its graph.';

create or replace function vortex_record.resolve_contributed_named_action_context_internal(
  p_base_context jsonb,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  contribution jsonb;
  action_content jsonb;
  permission_keys jsonb;
  set_field_ids jsonb;
  declaration jsonb;
begin
  -- A contributed action belongs to a Module installed beside this application, so it is found
  -- only among the installed contributions of this exact record type, by the contributor's exact
  -- release and the action's permanent identity.
  select entry.value into contribution
  from pg_catalog.jsonb_array_elements(
    vortex_record.installed_record_type_action_contributions_internal(
      (p_base_context #>> '{context,organizationId}')::uuid,
      (p_base_context ->> 'moduleRootId')::uuid,
      (p_base_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    )
  ) as entry(value)
  where (entry.value ->> 'contributorModuleRootId')::uuid = p_action_owner_id
    and (entry.value ->> 'contributorReleaseRevision')::bigint = p_action_release_revision
    and (entry.value ->> 'contributionId')::uuid = p_action_id;
  if contribution is null then
    raise exception using errcode = '55000', message = 'Named action owner is not installed';
  end if;

  -- The owner's own update declaration is the target authority: the person must be allowed to
  -- change this exact owner record. The contributor's named permission is a second requirement,
  -- decided by the same eligibility core.
  declaration := p_base_context -> 'declaration';
  if declaration is null or declaration #>> '{authority,kind}' is distinct from 'permission' then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;
  action_content := (contribution -> 'action')
    || pg_catalog.jsonb_build_object('subjectRecordTypeId', p_record_type_id);
  permission_keys := case when action_content ? 'permissionKeys'
    then action_content -> 'permissionKeys'
    else pg_catalog.jsonb_build_array(action_content -> 'permissionKey') end;
  if pg_catalog.jsonb_typeof(permission_keys) <> 'array'
    or pg_catalog.jsonb_array_length(permission_keys) = 0 then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(set_key.value)), '[]'::jsonb)
  into set_field_ids
  from pg_catalog.jsonb_array_elements_text(
    coalesce(action_content #> '{writePolicy,subjectFieldIds}', '[]'::jsonb)
  ) as set_key(value);

  return p_base_context || pg_catalog.jsonb_build_object(
    'actionOwner', pg_catalog.jsonb_build_object(
      'ownerKind', 'module',
      'ownerId', p_action_owner_id,
      'releaseRevision', p_action_release_revision
    ),
    'action', action_content,
    'validationContractVersion', (
      select release.validation_contract_version
      from vortex_definition.releases as release
      where release.root_id = (p_base_context ->> 'moduleRootId')::uuid
        and release.release_revision = (p_base_context ->> 'moduleReleaseRevision')::bigint
    ),
    'eventDescriptors', '[]'::jsonb,
    'declaration', declaration || pg_catalog.jsonb_build_object(
      'contributorRequirements', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', p_action_owner_id,
          'applicationRootIds', contribution -> 'contributorApplicationRootIds',
          'recordTypeId', contribution #>> '{action,subjectRecordTypeId}',
          'permissionKeys', permission_keys,
          'changeableFieldIds', set_field_ids
        )
      )
    )
  );
end
$function$;

alter function vortex_record.resolve_contributed_named_action_context_internal(jsonb,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_contributed_named_action_context_internal(
  jsonb, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_contributed_named_action_context_internal(
  jsonb, uuid, bigint, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.resolve_contributed_named_action_context_internal(
  jsonb, uuid, bigint, uuid, uuid
) is
  'Private exact installed contributed-action resolver for protected named actions: the contributor''s action re-bound to the owner record type under the owner''s own update declaration, with the contributor''s named permission as a second requirement.';

create or replace function vortex_record.resolve_named_action_context_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  base_context jsonb;
  context_value jsonb;
  installation jsonb;
  binding_value jsonb;
  release_content jsonb;
  release_validation_version text;
  application_content jsonb;
  action_content jsonb;
  action_owner_content jsonb;
  permission_candidates jsonb := '[]'::jsonb;
  permission_keys jsonb;
  permission_key text;
  matched_permission jsonb;
  required_permissions jsonb := '[]'::jsonb;
  named_action_value text;
  event_value jsonb;
  event_descriptor jsonb;
  event_descriptors jsonb := '[]'::jsonb;
  event_key text;
  matched_count integer;
begin
  if p_action_owner_kind is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Named action selector is invalid';
  end if;

  -- This existing fixed resolver owns active installation, target Module,
  -- storage/provision and field-map agreement. It decides no update authority.
  base_context := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, 'update'
  );
  context_value := base_context -> 'context';
  installation := vortex_definition.read_current_active_installation();

  -- A Module action whose own subject is not this record type in a release this installation
  -- binds is owned only as a contribution to this record type: the contributor may be installed
  -- beside this application, or bound by it and contribute one of its actions to another bound
  -- Module's record type. It is resolved from the installed contributions or not at all.
  if p_action_owner_kind = 'module' and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    join vortex_definition.releases as release
      on release.root_id = (item.value ->> 'moduleRootId')::uuid
      and release.release_revision = (item.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      coalesce(release.record_content -> 'actions', '[]'::jsonb)
    ) as own_action(value)
    where (item.value ->> 'moduleRootId')::uuid = p_action_owner_id
      and (item.value ->> 'moduleReleaseRevision')::bigint = p_action_release_revision
      and (own_action.value ->> 'actionId')::uuid = p_action_id
      and (own_action.value ->> 'subjectRecordTypeId')::uuid = p_record_type_id
  ) then
    return vortex_record.resolve_contributed_named_action_context_internal(
      base_context, p_action_owner_id, p_action_release_revision, p_action_id, p_record_type_id
    );
  end if;

  if p_action_owner_kind = 'application' then
    if p_action_owner_id <> (context_value ->> 'applicationRootId')::uuid
      or p_action_release_revision <>
        (installation ->> 'applicationReleaseRevision')::bigint then
      raise exception using errcode = '55000', message = 'Named action owner is not installed';
    end if;
    select release.record_content,
      release.validation_contract_version
    into strict action_owner_content, release_validation_version
    from vortex_definition.releases as release
    where release.root_id = p_action_owner_id
      and release.release_revision = p_action_release_revision;
  else
    select item.value into strict binding_value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'moduleRootId')::uuid = p_action_owner_id
      and (item.value ->> 'moduleReleaseRevision')::bigint = p_action_release_revision;
    select release.record_content,
      release.validation_contract_version
    into strict action_owner_content, release_validation_version
    from vortex_definition.releases as release
    where release.root_id = p_action_owner_id
      and release.release_revision = p_action_release_revision;
  end if;

  select item.value into strict action_content
  from pg_catalog.jsonb_array_elements(
    coalesce(action_owner_content -> 'actions', '[]'::jsonb)
  ) as item(value)
  where (item.value ->> 'actionId')::uuid = p_action_id
    and (item.value ->> 'subjectRecordTypeId')::uuid = p_record_type_id;

  permission_keys := case when action_content ? 'permissionKeys'
    then action_content -> 'permissionKeys'
    else pg_catalog.jsonb_build_array(action_content -> 'permissionKey') end;
  if pg_catalog.jsonb_typeof(permission_keys) <> 'array'
    or pg_catalog.jsonb_array_length(permission_keys) = 0 then
    raise exception using errcode = '55000', message = 'Named action permission is unavailable';
  end if;

  -- Collect the exact permission declarations of the active pin set that carry
  -- one of the action's permission keys; only those can match below. Access
  -- remains authoritative for current registrations, assignments and scopes.
  for binding_value in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    select release.record_content into strict release_content
    from vortex_definition.releases as release
    where release.root_id = (binding_value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_value ->> 'moduleReleaseRevision')::bigint;
    permission_candidates := permission_candidates || coalesce((
      select pg_catalog.jsonb_agg(
        item.value || pg_catalog.jsonb_build_object(
          'ownerKind', 'module',
          'ownerId', (binding_value ->> 'moduleRootId')::uuid
        )
        order by item.ordinality
      )
      from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'permissions', '[]'::jsonb)
      ) with ordinality as item(value, ordinality)
      where pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
        and item.value ->> 'key' in (
          select declared.value #>> '{}'
          from pg_catalog.jsonb_array_elements(permission_keys) as declared(value)
        )
    ), '[]'::jsonb);
  end loop;

  select release.record_content into strict application_content
  from vortex_definition.releases as release
  where release.root_id = (context_value ->> 'applicationRootId')::uuid
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  permission_candidates := permission_candidates || coalesce((
    select pg_catalog.jsonb_agg(
      item.value || pg_catalog.jsonb_build_object(
        'ownerKind', 'application',
        'ownerId', (context_value ->> 'applicationRootId')::uuid
      )
      order by item.ordinality
    )
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) with ordinality as item(value, ordinality)
    where pg_catalog.jsonb_typeof(item.value -> 'recordScope') = 'object'
      and item.value ->> 'key' in (
        select declared.value #>> '{}'
        from pg_catalog.jsonb_array_elements(permission_keys) as declared(value)
      )
  ), '[]'::jsonb);
  for permission_key in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(permission_keys) as item(value)
  loop
    select pg_catalog.count(*), pg_catalog.min(item.value::text)::jsonb
    into matched_count, matched_permission
    from pg_catalog.jsonb_array_elements(permission_candidates) as item(value)
    where item.value ->> 'key' = permission_key;
    if matched_count <> 1
      or matched_permission ->> 'actionKind' <> 'named'
      or (matched_permission ->> 'recordTypeId')::uuid <> p_record_type_id
      or (matched_permission ->> 'namedAction') is null then
      raise exception using errcode = '55000', message = 'Named action permission is ambiguous';
    end if;
    if named_action_value is null then
      named_action_value := matched_permission ->> 'namedAction';
    elsif named_action_value is distinct from matched_permission ->> 'namedAction' then
      raise exception using errcode = '55000', message = 'Named action permission alternatives disagree';
    end if;
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid,
        'ownerKind', matched_permission ->> 'ownerKind',
        'ownerId', (matched_permission ->> 'ownerId')::uuid,
        'permissionId', (matched_permission ->> 'permissionId')::uuid
      )
    );
  end loop;
  select pg_catalog.jsonb_agg(item.value order by
    item.value ->> 'ownerKind' collate "C",
    item.value ->> 'ownerId' collate "C",
    item.value ->> 'permissionId' collate "C")
  into required_permissions
  from pg_catalog.jsonb_array_elements(required_permissions) as item(value);

  for event_key in
    select item.value from pg_catalog.jsonb_array_elements_text(
      coalesce(action_content #> '{writePolicy,eventKeys}', '[]'::jsonb)
    ) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    select item.value into strict event_value
    from pg_catalog.jsonb_array_elements(
      coalesce(action_owner_content -> 'events', '[]'::jsonb)
    ) as item(value)
    where item.value ->> 'key' = event_key
      and (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    event_descriptor := pg_catalog.jsonb_build_object(
      'kind', 'declared',
      'owner', case when p_action_owner_kind = 'application'
        then pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', p_action_owner_id
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'module', 'moduleRootId', p_action_owner_id
        ) end,
      'declarationId', event_value -> 'eventId',
      'key', event_value -> 'key',
      'recordTypeId', event_value -> 'recordTypeId',
      'carriedFieldIds', event_value -> 'carriedFieldIds'
    );
    event_descriptors := event_descriptors || pg_catalog.jsonb_build_array(event_descriptor);
  end loop;

  return base_context || pg_catalog.jsonb_build_object(
    'actionOwner', pg_catalog.jsonb_build_object(
      'ownerKind', p_action_owner_kind,
      'ownerId', p_action_owner_id,
      'releaseRevision', p_action_release_revision
    ),
    'action', action_content,
    -- Action values follow the subject Record's owning Module contract. An
    -- Application version cannot reinterpret exact Module field values.
    'validationContractVersion', (
      select release.validation_contract_version
      from vortex_definition.releases as release
      where release.root_id = (base_context ->> 'moduleRootId')::uuid
        and release.release_revision = (base_context ->> 'moduleReleaseRevision')::bigint
    ),
    'eventDescriptors', event_descriptors,
    'declaration', pg_catalog.jsonb_build_object(
      'operationKey', action_content -> 'key',
      'action', pg_catalog.jsonb_build_object(
        'actionKind', 'named', 'namedAction', named_action_value
      ),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', (context_value ->> 'applicationRootId')::uuid
      ),
      'requiredPermissions', required_permissions,
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', (base_context ->> 'moduleRootId')::uuid,
        'recordTypeId', p_record_type_id,
        'storageContractId', (base_context ->> 'storageContractId')::uuid,
        'storageScope', base_context ->> 'storageScope'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  );
exception
  when no_data_found then
    raise exception using errcode = '55000', message = 'Installed named action is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Installed named action is ambiguous';
end
$function$;

alter function vortex_record.resolve_named_action_context_internal(text,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.resolve_named_action_context_internal(
  text, uuid, bigint, uuid, uuid
) is
  'Private exact active installed action, permission-alternative and declared-Event resolver for protected named actions.';

reset role;
