set role vortex_owner;

create or replace function vortex_definition.accepted_contract_version(
  p_kind text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  case p_kind
    when 'application' then
      return array['4.2.0'];
    when 'module' then
      return array['4.2.0'];
    when 'record_type' then
      return array['4.2.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

revoke all on function vortex_definition.accepted_contract_version(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.accepted_contract_version(text)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_definition.accepted_contract_version(text) is
  'The one accepted definition contract version per contract kind (a one-element array); the single SQL source of truth, compared with the TypeScript constants by the guard. application: vortex_definition.provision_module_installation_storage and vortex_definition.activate_application_installation (detach checks release identity only). module: vortex_record.provision_exact_module_storage. record_type: vortex_access.evaluate_organization_record_access_internal.';

alter function vortex_definition.accepted_contract_version(p_kind text) owner to vortex_owner;

grant execute on function vortex_definition.accepted_contract_version(p_kind text) to postgres;

-- Contract 4.2.0: a named action runs one flow of its Module. Every stored draft moves each action's
-- ordered tasks into an ordinary transaction flow the action references, once, in place.
create function pg_temp.contract_42_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  result text;
  member text;
  first boolean := true;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := '{';
      for member in
        select item.key from pg_catalog.jsonb_object_keys(p_value) as item(key)
        order by item.key collate "C"
      loop
        result := result || case when first then '' else ',' end
          || pg_catalog.to_json(member)::text || ':'
          || pg_temp.contract_42_canonical_json(p_value -> member);
        first := false;
      end loop;
      return result || '}';
    when 'array' then
      return '[' || coalesce((
        select pg_catalog.string_agg(pg_temp.contract_42_canonical_json(item.value), ',' order by item.ordinality)
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, ordinality)
      ), '') || ']';
    when 'string' then
      return pg_catalog.to_json(p_value #>> '{}')::text;
    else
      return p_value::text;
  end case;
end
$function$;

create function pg_temp.contract_42_fingerprint(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_temp.contract_42_canonical_json(p_value), 'UTF8')),
    'hex'
  )
$function$;

-- One authored action task as the flow task it was always compiled to.
create function pg_temp.contract_42_task(p_task jsonb, p_record text, p_subject text)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  properties jsonb := p_task -> 'properties';
  flow_properties jsonb;
  changes jsonb := '[]'::jsonb;
  change jsonb;
begin
  case p_task ->> 'type'
    when 'record.set_fields' then
      flow_properties := pg_catalog.jsonb_build_object(
        'values', pg_catalog.jsonb_build_object('kind', 'map', 'entries', properties -> 'values'));
    when 'record.create' then
      flow_properties := pg_catalog.jsonb_build_object(
        'record_type', pg_catalog.jsonb_build_object('kind', 'literal',
          'literal', pg_catalog.jsonb_build_object('type', 'text', 'value', properties -> 'record_type')),
        'values', pg_catalog.jsonb_build_object('kind', 'map', 'entries', properties -> 'values'));
    when 'record.changes' then
      for change in select item.value from pg_catalog.jsonb_array_elements(properties -> 'changes') as item(value) loop
        changes := changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind', 'copy_relationships',
          'relationshipIds', (
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p_record || '.' || (relationship.value #>> '{}'))
              order by relationship.ordinality)
            from pg_catalog.jsonb_array_elements(change -> 'relationships')
              with ordinality as relationship(value, ordinality)),
          'subject', pg_catalog.jsonb_build_object('kind', 'reference',
            'reference', pg_catalog.jsonb_build_object('source', 'input', 'name', p_subject)),
          'target', pg_catalog.jsonb_build_object('kind', 'reference',
            'reference', pg_catalog.jsonb_build_object('source', 'input', 'name', change -> 'target_input'))));
      end loop;
      flow_properties := pg_catalog.jsonb_build_object(
        'changes', pg_catalog.jsonb_build_object('kind', 'literal',
          'literal', pg_catalog.jsonb_build_object('type', 'json', 'value', changes)));
    when 'record.delete' then
      flow_properties := pg_catalog.jsonb_build_object(
        'record_type', pg_catalog.jsonb_build_object('kind', 'literal',
          'literal', pg_catalog.jsonb_build_object('type', 'text', 'value', p_record)),
        'record', pg_catalog.jsonb_build_object('kind', 'reference',
          'reference', pg_catalog.jsonb_build_object('source', 'input', 'name', p_subject)));
    when 'event.announce' then
      flow_properties := pg_catalog.jsonb_build_object(
        'event', pg_catalog.jsonb_build_object('kind', 'literal',
          'literal', pg_catalog.jsonb_build_object('type', 'text', 'value', properties -> 'event')));
    else
      raise exception 'contract 4.2.0 cannot convert action task type %', p_task ->> 'type';
  end case;
  return pg_catalog.jsonb_build_object(
    'id', p_task -> 'id', 'type', p_task -> 'type', 'version', '1.0.0', 'properties', flow_properties);
end
$function$;

-- One authored Module: each action's tasks become the tasks of a new transaction flow.
create function pg_temp.contract_42_module(p_module jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  actions jsonb := '[]'::jsonb;
  flows jsonb := coalesce(p_module -> 'flows', '[]'::jsonb);
  taken text[];
  flow_keys text[];
  action jsonb;
  action_input jsonb;
  task jsonb;
  flow_id text;
  flow_key text;
  base text;
  suffix integer;
  subject text;
  flow_inputs jsonb;
  flow_tasks jsonb;
begin
  if pg_catalog.jsonb_typeof(p_module -> 'actions') is distinct from 'array' then
    return p_module;
  end if;
  select coalesce(pg_catalog.array_agg(distinct item.value #>> '{}'), array[]::text[]) into taken
  from pg_catalog.jsonb_path_query(p_module, 'lax $.**.id') as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';
  select coalesce(pg_catalog.array_agg(item.value ->> 'key'), array[]::text[]) into flow_keys
  from pg_catalog.jsonb_array_elements(flows) as item(value);
  for action in select item.value from pg_catalog.jsonb_array_elements(p_module -> 'actions') as item(value) loop
    if not action ? 'tasks' then
      actions := actions || pg_catalog.jsonb_build_array(action);
      continue;
    end if;
    -- A protected-operation action declared an empty task list.
    if pg_catalog.jsonb_array_length(action -> 'tasks') = 0 then
      actions := actions || pg_catalog.jsonb_build_array(action - 'tasks');
      continue;
    end if;
    base := 'flow_' || pg_catalog.regexp_replace(action ->> 'id', '^act(ion)?_', '');
    flow_id := base;
    suffix := 1;
    while flow_id = any (taken) loop
      suffix := suffix + 1;
      flow_id := base || '_' || suffix::text;
    end loop;
    taken := pg_catalog.array_append(taken, flow_id);
    base := pg_catalog.regexp_replace(
      pg_catalog.left(pg_catalog.regexp_replace(action ->> 'key', '^.*\.', ''), 32), '_+$', '');
    flow_key := base;
    suffix := 1;
    while flow_key = any (flow_keys) loop
      suffix := suffix + 1;
      flow_key := base || '_' || suffix::text;
    end loop;
    flow_keys := pg_catalog.array_append(flow_keys, flow_key);
    -- The subject is `record` unless the action declares an input of that name.
    subject := 'record';
    suffix := 1;
    while exists (
      select 1 from pg_catalog.jsonb_array_elements(action -> 'inputs') as item(value)
      where item.value ->> 'key' = subject
    ) loop
      suffix := suffix + 1;
      subject := case when suffix = 2 then 'subject_record' else 'subject_record_' || (suffix - 1)::text end;
    end loop;
    flow_inputs := pg_catalog.jsonb_build_object(subject, pg_catalog.jsonb_build_object(
      'type', 'record_reference', 'required', true,
      'recordTypeIds', pg_catalog.jsonb_build_array(action -> 'record_type'),
      'description', 'The record the action runs on.'));
    for action_input in select item.value from pg_catalog.jsonb_array_elements(action -> 'inputs') as item(value) loop
      flow_inputs := flow_inputs || pg_catalog.jsonb_build_object(action_input ->> 'key',
        pg_catalog.jsonb_build_object('type', action_input -> 'type', 'required', action_input -> 'required')
        || case when action_input ->> 'type' = 'record_reference'
          then pg_catalog.jsonb_build_object('recordTypeIds', action_input -> 'record_types') else '{}'::jsonb end);
    end loop;
    flow_tasks := '[]'::jsonb;
    for task in select item.value from pg_catalog.jsonb_array_elements(action -> 'tasks') as item(value) loop
      flow_tasks := flow_tasks || pg_catalog.jsonb_build_array(
        pg_temp.contract_42_task(task, action ->> 'record_type', subject));
    end loop;
    flows := flows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', flow_id, 'key', flow_key, 'labels', '{}'::jsonb, 'execution', 'transaction',
      'runAs', pg_catalog.jsonb_build_object('kind', 'saver'), 'inputs', flow_inputs,
      'recordInput', subject, 'variables', '{}'::jsonb, 'triggers', '[]'::jsonb,
      'tasks', flow_tasks, 'outputs', '{}'::jsonb, 'errors', '[]'::jsonb, 'finally', '[]'::jsonb));
    actions := actions || pg_catalog.jsonb_build_array((action - 'tasks') || pg_catalog.jsonb_build_object('flow', flow_id));
  end loop;
  return pg_catalog.jsonb_set(pg_catalog.jsonb_set(p_module, '{actions}', actions), '{flows}', flows);
end
$function$;

do $convert$
declare
  draft record;
  converted jsonb;
  body jsonb;
begin
  for draft in select d.root_id, r.key, d.draft_source, d.source_fingerprint
    from vortex_definition.drafts d join vortex_definition.roots r on r.root_id = d.root_id
  loop
    if pg_temp.contract_42_fingerprint(draft.draft_source) is distinct from draft.source_fingerprint then
      raise exception 'Contract 4.2.0 cannot verify stored fingerprint of draft % (%)', draft.key, draft.root_id;
    end if;
  end loop;
  for draft in select d.root_id, d.draft_source
    from vortex_definition.drafts d
    order by d.root_id
  loop
    body := draft.draft_source -> 'body';
    if pg_catalog.jsonb_typeof(body -> 'modules') = 'array' then
      body := pg_catalog.jsonb_set(body, '{modules}', (
        select coalesce(pg_catalog.jsonb_agg(pg_temp.contract_42_module(item.value) order by item.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(body -> 'modules') with ordinality as item(value, ordinality)));
    else
      body := pg_temp.contract_42_module(body);
    end if;
    converted := pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(draft.draft_source, '{body}', body),
      '{source_contract_version}', '"4.2.0"'::jsonb);
    update vortex_definition.drafts d set
      draft_source = converted,
      source_contract_version = '4.2.0',
      source_fingerprint = pg_temp.contract_42_fingerprint(converted),
      draft_revision = d.draft_revision + 1,
      updated_at = greatest(pg_catalog.statement_timestamp(), d.updated_at),
      restored_from_release_revision = null,
      restored_from_source_fingerprint = null,
      restored_by = null, restored_at = null, restore_correlation_id = null
    where d.root_id = draft.root_id;
  end loop;
end
$convert$;

drop function pg_temp.contract_42_module(jsonb);
drop function pg_temp.contract_42_task(jsonb, text, text);
drop function pg_temp.contract_42_fingerprint(jsonb);
drop function pg_temp.contract_42_canonical_json(jsonb);

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

create or replace function vortex_record.prepare_record_create_internal(
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
  selected_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  physical_values jsonb := '{}'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  storage_change jsonb;
  preview_installation jsonb;
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
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object')
      or (preview_installation is not null
        and (preview_installation ->> 'outcome' = 'refused'
          or meta -> 'recordType' ? 'systemProjection')) then
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
      -- A create that selects no Group (a flow step has no one to ask) is owned by the one
      -- Group the account currently belongs to; none or several refuse it.
      selected_group_id := coalesce(p_selected_group_id, (
        select case when pg_catalog.count(*) = 1
          then (pg_catalog.array_agg(owner_group.group_id))[1] end
        from vortex_access.list_current_record_owner_groups() as owner_group
      ));
      if not vortex_access.lock_current_record_owner_group_internal(selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := selected_group_id;
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
        input_value := pg_catalog.to_jsonb(case when preview_installation is null
          then vortex_record.allocate_reference_number_internal(
            (context_value ->> 'organizationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, app_scope, field_item -> 'settings'
          )
          else vortex_record.allocate_preview_reference_number_internal(
            (preview_installation ->> 'previewInstallationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, field_item -> 'settings'
          ) end);
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

      physical_values := physical_values || pg_catalog.jsonb_build_object(
        column_value ->> 'token', input_value
      );
    end loop;

    storage_change := pg_catalog.jsonb_build_object(
        'storageContractId', meta -> 'storageContractId', 'recordId', record_id_value,
        'expectedConcurrencyNumber', null,
        'values', physical_values || pg_catalog.jsonb_build_object(
          'module_root_id', meta -> 'moduleRootId', 'record_type_id', p_record_type_id,
          'storage_contract_id', meta -> 'storageContractId', 'application_root_id', app_scope,
          'definition_revision', meta -> 'moduleReleaseRevision',
          'owner_organisation_account_id', owner_account_id, 'owner_group_id', owner_group_id,
          'lifecycle_state', 'active', 'created_at', pg_catalog.statement_timestamp(),
          'created_by', context_value -> 'organizationAccountId'
        )
    );

    -- The canonical link-target share-lock prelude is written once in
    -- lock_record_change_targets_internal. Every created link's target row is
    -- locked here before any edge identity, so a multi-link create uses the
    -- same lock order as the update writer. A malformed or undeclared link
    -- is left to the writer's own validation.
    perform vortex_record.lock_record_change_targets_internal(
      record_type_value, (context_value ->> 'organizationId')::uuid, final_values
    );
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        edge_changes := edge_changes || pg_catalog.jsonb_build_array(
          vortex_record.prepare_relationship_value_internal(
            p_record_type_id, record_id_value,
            (relationship_value ->> 'relationshipId')::uuid,
            final_values -> pg_catalog.lower(field_id_value::text), false
          )
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'recordTypeId', p_record_type_id,
      'recordId', record_id_value, 'values', final_values,
      'submittedFieldIds', pg_catalog.to_jsonb(p_submitted_field_ids),
      'storageChange', storage_change, 'edgeChanges', edge_changes
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

alter function vortex_record.prepare_record_create_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_create_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_create_internal(uuid, jsonb, uuid[], uuid) is
  'Private create preparation: derives trusted scope, ownership and generated references, validates typed fields and relationship targets, and returns storage and edge mutations without inserting the record.';

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
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
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
  'Private named-action subject preparation shared by preview and command execution: resolves current action authority and locked facts without reading or writing a command receipt or Activity.';

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

drop function vortex_record.named_action_creation_plan_internal(text, uuid, bigint, uuid, uuid, jsonb, jsonb);
drop function vortex_record.prepare_named_action_relationship_copies_internal(text, uuid, bigint, uuid, uuid, uuid, jsonb, jsonb);

reset role;
