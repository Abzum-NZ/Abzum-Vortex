-- #3304: row-action previews of a grid page cost one page read; a page resolves each action context once.

set local role vortex_record_adapter;

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

  -- The context depends only on the action and the record type: a page that previews
  -- one action for many records resolves it once and passes it here; null resolves it now.
  action_context := coalesce(p_action_context, vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  ));
  if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
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
    target_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', copy_target.record_id, null, null::jsonb
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
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb, jsonb
) is
  'Private named-action preparation: replays or refuses by command receipt, then returns the facts, permission decision and bounds of the exact installed action, writing nothing; a preview may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';

CREATE OR REPLACE FUNCTION vortex_record.prepare_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select vortex_record.prepare_named_action_set_announce_internal(
    false, p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs, p_activity_id, null::jsonb, null::jsonb
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
    p_expected_concurrency_number, p_inputs, p_activity_id, null::jsonb, null::jsonb
  )
$$;
alter function vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) TO vortex_runtime;

create or replace function vortex_record.read_record_with_action_previews(
  p_record_type_id uuid,
  p_record_id uuid,
  p_actions jsonb,
  p_requested_field_ids jsonb
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
  from vortex_record.read_record_projection_internal(
    p_record_type_id, p_record_id,
    -- A preview validates the complete proposed record, including unchanged required values.
    case when pg_catalog.jsonb_array_length(p_actions) > 0 then null else p_requested_field_ids end
  ) as row_read;
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
          (action_item ->> 'activityId')::uuid, read_row.read_facts, null::jsonb
        )
      ));
    end loop;
  end if;
  return pg_catalog.jsonb_build_object(
    'record', read_row.projection,
    'capabilities', case when read_row.projection ->> 'outcome' = 'allowed'
      then vortex_record.read_record_capabilities_internal(
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds, null::jsonb
      ) end,
    'previews', previews
  );
end
$function$;

alter function vortex_record.read_record_with_action_previews(uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb, jsonb) to vortex_runtime;

comment on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb, jsonb) is
  'Fixed record adapter for a page subject and the named actions its placements are bound to: from one read decision under the caller''s current authority, the readable projection (record) and capabilities vortex_record.read_record_with_capabilities returns, and, only when the record is readable, each action''s preview exactly as vortex_record.preview_named_action_set_announce returns it for the record''s current concurrency number and no inputs (previews, in the order given), writing nothing.';

create or replace function vortex_record.read_records_with_action_previews(
  p_record_type_id uuid,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_ids uuid[];
  requested_id uuid;
  target_position integer;
  action_item jsonb;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[] := array[]::jsonb[];
  decided_decisions jsonb[] := array[]::jsonb[];
  decided_bounds jsonb[] := array[]::jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  read_facts jsonb;
  preview_meta jsonb;
  preview_installation_id uuid;
  previews jsonb[];
  results jsonb[] := array[]::jsonb[];
  action_contexts jsonb := '{}'::jsonb;
  context_key text;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(target.value ->> 'recordId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(target.value -> 'actions') is distinct from 'array'
        or pg_catalog.jsonb_array_length(target.value -> 'actions') > 20
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(target.value -> 'actions') as item(value)
          where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
            or item.value ->> 'ownerKind' is null
            or item.value ->> 'ownerKind' not in ('application', 'module')
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'activityId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid'), false)
            or not coalesce(case when pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint')
              then (item.value ->> 'releaseRevision')::bigint between 1 and 9007199254740991 end, false)
        )
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  select coalesce(pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by target.ordinality),
    array[]::uuid[])
  into target_ids
  from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality);

  -- The page read pass the list read uses (#2668): the first readable record
  -- is decided exactly and supplies the installation-wide facts; the other
  -- records are decided together from them. A record the pass does not decide
  -- (missing, inaccessible or relationship-routed) keeps the exact
  -- single-record path with the same refusal. The eligibility is local to this
  -- invocation and narrows work only when each record's projection confirms
  -- the same declaration and a live deadline.
  if p_record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid then
    foreach requested_id in array target_ids loop
      if requested_id = '00000000-0000-0000-0000-000000000000'::uuid then
        continue;
      end if;
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'read', requested_id, null, null::jsonb
      );
      if loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
        page_declaration := loaded -> 'declaration';
        if loaded ? 'previewInstallationId' then
          preview_installation_id := (loaded ->> 'previewInstallationId')::uuid;
          preview_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
          page_shared := pg_catalog.jsonb_build_object('previewBounds',
            vortex_record.preview_record_field_bounds_internal(
              p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
              preview_meta -> 'recordType'));
        else
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
        first_loaded_id := requested_id;
        first_loaded := loaded;
        exit;
      end if;
    end loop;
  end if;
  if first_loaded is not null then
    select pg_catalog.array_agg(distinct candidate.id)
    into candidate_ids
    from pg_catalog.unnest(target_ids) as candidate(id)
    where candidate.id <> first_loaded_id
      and candidate.id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end if;
  if candidate_ids is not null then
    select coalesce(page_shared, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
      page.narrowed
    into page_shared, page_narrowed
    from vortex_record.read_record_page_envelope_internal(p_record_type_id, first_loaded) as page;
    -- At most 199 candidates (200 targets, the first decided exactly).
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
    into decided_ids, decided_loaded, decided_decisions, decided_bounds
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, first_loaded, page_declaration, page_eligibility,
      candidate_ids, page_shared -> 'envelope', page_narrowed
    ) as decided;
  end if;

  for target_position in 1 .. pg_catalog.cardinality(target_ids) loop
    requested_id := target_ids[target_position];
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
    previews := array[]::jsonb[];
    if projection ->> 'outcome' = 'allowed' then
      -- A decided record carries its compact scope; its complete read facts are
      -- the page envelope with that scope. Each bound action is still decided
      -- against its own declaration, never by the record's read decision.
      read_facts := case when decided_index is not null
        then vortex_record.read_record_page_row_facts_internal(page_shared -> 'envelope', row_read.read_facts)
        else row_read.read_facts end;
      for action_item in
        select item.value
        from pg_catalog.jsonb_array_elements(p_targets -> (target_position - 1) -> 'actions')
          with ordinality as item(value, ordinality)
        order by item.ordinality
      loop
        -- An action's context depends only on the action and the record type, not on the
        -- record: it is resolved once per page. A resolution that fails is not cached as a
        -- context: each record's preview then decides it (and its replay) itself.
        context_key := pg_catalog.lower(action_item ->> 'ownerKind') || ':'
          || pg_catalog.lower(action_item ->> 'ownerId') || ':'
          || ((action_item ->> 'releaseRevision')::bigint)::text || ':'
          || pg_catalog.lower(action_item ->> 'actionId');
        if not action_contexts ? context_key then
          begin
            action_contexts := action_contexts || pg_catalog.jsonb_build_object(context_key,
              vortex_record.resolve_named_action_context_internal(
                action_item ->> 'ownerKind', (action_item ->> 'ownerId')::uuid,
                (action_item ->> 'releaseRevision')::bigint, (action_item ->> 'actionId')::uuid,
                p_record_type_id));
          exception
            when no_data_found or too_many_rows or insufficient_privilege
              or object_not_in_prerequisite_state or check_violation then
              action_contexts := action_contexts || pg_catalog.jsonb_build_object(context_key, false);
          end;
        end if;
        previews := pg_catalog.array_append(previews, pg_catalog.jsonb_build_object(
          'actionId', action_item -> 'actionId',
          -- An unresolvable context passes null, so the preview resolves it itself after its
          -- command-receipt replay check and refuses exactly as the single preview does.
          'preview', vortex_record.prepare_named_action_set_announce_internal(
            true, (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
            (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
            (action_item ->> 'actionId')::uuid, p_record_type_id, requested_id,
            (projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
            (action_item ->> 'activityId')::uuid, read_facts,
            nullif(action_contexts -> context_key, 'false'::jsonb)
          )
        ));
      end loop;
    end if;
    results := pg_catalog.array_append(results, pg_catalog.jsonb_build_object(
      'recordId', requested_id,
      'record', case when projection ->> 'outcome' = 'allowed'
        then pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', projection -> 'recordId',
          'concurrencyNumber', projection -> 'concurrencyNumber')
        else projection end,
      'previews', pg_catalog.to_jsonb(previews)
    ));
  end loop;
  -- PL/pgSQL materializes the result before returning it. Revalidate after all
  -- reads so invocation-local preview facts cannot extend a builder's expiring
  -- role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview authority is unavailable';
  end if;
  return pg_catalog.to_jsonb(results);
end
$function$;

alter function vortex_record.read_records_with_action_previews(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_records_with_action_previews(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_records_with_action_previews(uuid, jsonb) to vortex_runtime;

comment on function vortex_record.read_records_with_action_previews(uuid, jsonb) is
  'Fixed record adapter for a grid page of records and the named actions bound to each: reads every target through the page read pass the list read uses (the first readable record decided exactly, the others together, any record the pass does not decide by the exact single-record path), and, only for a readable record, returns each action''s preview exactly as vortex_record.preview_named_action_set_announce returns it for the record''s current concurrency number and no inputs (previews, in the order given), under the caller''s current authority and writing nothing; a readable record is reported by its recordId and concurrencyNumber, an unreadable one as refused.';

drop function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb);

reset role;
