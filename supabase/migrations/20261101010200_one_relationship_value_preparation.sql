-- DF-8: one relationship value preparation. The named-action copy differed only in deciding a
-- target that is the action's own subject on the installed named declaration; that branch joins
-- vortex_record.prepare_relationship_value_internal, taken when the caller passes the action, and
-- the copy goes. The one caller of the copy passes the action instead.

set role vortex_record_adapter;

drop function vortex_record.prepare_named_action_relationship_value_internal(uuid, uuid, uuid, jsonb, text, uuid, bigint, uuid, uuid, uuid);
drop function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean);

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.prepare_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_bump_data_version boolean,
  p_named_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id uuid;

begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_bump_data_version is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  -- A named action's relationship change names the action (its plan's action object); the
  -- action's subject is the source record.
  if p_named_action is not null then
    begin
      action_owner_kind := p_named_action ->> 'ownerKind';
      action_owner_id := (p_named_action ->> 'ownerId')::uuid;
      action_release_revision := (p_named_action ->> 'releaseRevision')::bigint;
      action_id := (p_named_action ->> 'actionId')::uuid;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using errcode = '22023', message = 'Relationship change is invalid';
    end;
    if action_owner_kind is null or action_owner_kind not in ('application', 'module')
      or action_owner_id is null or action_id is null
      or action_release_revision is null
      or action_release_revision not between 1 and 9007199254740991 then
      raise exception using errcode = '22023', message = 'Relationship change is invalid';
    end if;
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  if source_meta ? 'previewInstallationId' then
    -- The exact owner-validated preview definition is its mapping. A live mapping's single
    -- relationship identity must never be repointed at a preview's isolated storage.
    mapping_row.source_storage_contract_id := (source_meta ->> 'storageContractId')::uuid;
    mapping_row.cardinality := relationship_value ->> 'cardinality';
    mapping_row.on_parent_delete := relationship_value ->> 'onParentDelete';
    select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid)
    into mapping_row.target_record_type_ids
    from pg_catalog.jsonb_array_elements(case when relationship_value ? 'toRecordType'
      then pg_catalog.jsonb_build_array(relationship_value -> 'toRecordType')
      else relationship_value -> 'toRecordTypes' end) as target(value);
  else
    select mapping.* into mapping_row
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.relationship_id = p_relationship_id
      and mapping.source_storage_contract_id =
        (source_meta ->> 'storageContractId')::uuid
      and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
      and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
    if not found
      or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
      or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
      raise exception using errcode = '55000',
        message = 'Relationship storage disagrees with the active definition';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_bump_data_version then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    return pg_catalog.jsonb_build_object(
      'relationshipId', p_relationship_id,
      'sourceRecordId', p_source_record_id,
      'sourceStorageContractId', source_meta -> 'storageContractId',
      'sourceApplicationRootId', case when source_meta ->> 'storageScope' = 'application_contained'
        then source_context -> 'applicationRootId' else null end,
      'table', source_meta -> 'table', 'column', field_column -> 'token',
      'value', p_target_value, 'cardinality', mapping_row.cardinality
    );
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- Lock the protected row behind either ordinary record storage or a
  -- registered system projection before rebuilding eligibility from current
  -- facts. The lock is held until commit, so the target cannot disappear while
  -- the unconstrainted relationship edge is installed.
  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  -- Executing a permitted named action must not require ordinary read authority on its own
  -- subject, so when the target is exactly the action's subject the decision is taken on the
  -- installed named declaration: the loader re-resolves the active installation, the owner kind,
  -- id and release revision, the action and its declared subject record type. Every other
  -- target keeps the ordinary read check.
  if p_named_action is not null
    and target_type_id = p_source_record_type_id and target_record_id = p_source_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := (vortex_record.load_record_access_facts_internal('read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', target_type_id, 'recordId', target_record_id))) -> 0);
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if p_named_action is not null
    and target_type_id = p_source_record_type_id and target_record_id = p_source_record_id then
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', target_loaded -> 'declaration',
        'recordId', target_record_id,
        'facts', target_loaded -> 'facts'
      )
    )) -> 0);
  elsif source_meta ? 'previewInstallationId'
    and target_loaded ->> 'previewInstallationId' = source_meta ->> 'previewInstallationId'
    and exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
        and root.owner_application_root_id = (source_context ->> 'applicationRootId')::uuid
    ) then
    target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
  else
    if pg_catalog.jsonb_array_length(
      target_loaded #> '{declaration,requiredPermissions}'
    ) = 0 then
      raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb), 'recordId', target_record_id, 'facts', target_loaded -> 'facts'))) -> 0);
  end if;
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_bump_data_version then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  -- Parent proposals serialize before storage and edge writes, but cardinality
  -- and cycles are checked by the edge writer on the complete resulting graph.
  -- Checking the old graph here would reject valid swaps within one set.
  if mapping_row.cardinality = 'many_to_one' and target_type_id = p_source_record_type_id then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'parent:' || (source_context ->> 'organizationId') || ':' || p_relationship_id::text, 0
    ));
  end if;

  return pg_catalog.jsonb_build_object(
    'relationshipId', p_relationship_id,
    'sourceRecordId', p_source_record_id,
    'sourceStorageContractId', source_meta -> 'storageContractId',
    'sourceApplicationRootId', source_application_root_id,
    'targetStorageContractId', target_meta -> 'storageContractId',
    'targetRecordId', target_record_id,
    'targetApplicationRootId', target_application_root_id,
    'table', source_meta -> 'table', 'column', field_column -> 'token',
    'value', p_target_value, 'cardinality', mapping_row.cardinality
  );
end
$function$;

alter function vortex_record.prepare_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean, jsonb) is
  'Private relationship preparation: validates the declared relationship and target eligibility, locks target and edge identities, and returns the typed field and edge mutation for the record writer. A named action''s change passes the action, and a target that is the action''s own subject is decided on the installed named declaration.';

create or replace function vortex_record.apply_prepared_record_set_internal(p_preparation jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
  edge_changes jsonb := p_preparation -> 'edgeChanges';
  written jsonb;
  plan jsonb;
  subject jsonb;
  restored_subject jsonb;
  restored_subjects jsonb := '[]'::jsonb;
  prepared jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  relationship_value jsonb;
  results jsonb := '[]'::jsonb;
  result_value jsonb;
  create_results jsonb := '[]'::jsonb;
  create_indexes integer[] := array[]::integer[];
  update_targets jsonb := '[]'::jsonb;
  update_indexes integer[] := array[]::integer[];
  update_loaded jsonb[] := array[]::jsonb[];
  update_decisions jsonb[] := array[]::jsonb[];
  loaded_set jsonb;
  decision_set jsonb;
  set_position integer;
  target_position integer;
begin
  if p_preparation ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_typeof(p_preparation -> 'plans') is distinct from 'array'
    or pg_catalog.jsonb_typeof(edge_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Prepared record set is invalid';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  storage_changes := vortex_record.combine_record_storage_changes_internal(p_preparation -> 'storageChanges');
  written := vortex_record.apply_record_storage_changes_internal(storage_changes);

  -- Restores can overlap, and generated totals can change the same row. Reload
  -- the combined persisted values rather than validate a root's partial copy.
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    where item.value #>> '{subject,operation}' = 'restore'
  loop
    for restored_subject in
      select item.value from pg_catalog.jsonb_array_elements(plan #> '{prepared,subjects}') as item(value)
    loop
      loaded := (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (restored_subject ->> 'recordTypeId')::uuid, 'recordId', (restored_subject ->> 'recordId')::uuid))) -> 0);
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '42501', message = 'Restored record is unavailable';
      end if;
      restored_subjects := restored_subjects || pg_catalog.jsonb_build_array(
        restored_subject || pg_catalog.jsonb_build_object(
          'values', loaded -> 'fieldValues'
        )
      );
    end loop;
  end loop;
  edge_changes := edge_changes || vortex_record.prepare_record_restore_edges_internal(restored_subjects);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      item.value -> 'targetStorageContractId', item.value -> 'targetRecordId'
    )) > 1
  ) then
    raise exception using errcode = '23514', message = 'Record relationship changes conflict';
  end if;
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.value ->> 'relationshipId',
    candidate.value ->> 'sourceStorageContractId', candidate.value ->> 'sourceRecordId'), '[]'::jsonb)
  into edge_changes
  from (
    select distinct on (item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId')
      item.value
    from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    order by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
  ) as candidate;
  perform vortex_record.apply_relationship_edges_internal(edge_changes);

  -- Every decision below sees the complete storage and relationship graph. A
  -- refusal raises, so callers cannot commit a partially authorized set.
  perform vortex_record.validate_record_restore_set_internal(restored_subjects);
  -- Created records finish together, and the access of every plainly changed record is decided
  -- with one facts load and one decision for the whole set.
  select coalesce(pg_catalog.array_agg((item.value ->> 'index')::integer order by (item.value ->> 'index')::integer), array[]::integer[])
  into create_indexes
  from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
  where item.value #>> '{subject,operation}' = 'create' and not (item.value #> '{meta,recordType}' ? 'systemProjection');
  if pg_catalog.cardinality(create_indexes) > 0 then
    create_results := vortex_record.complete_record_creates_internal((
      select pg_catalog.jsonb_agg(item.value -> 'prepared' order by (item.value ->> 'index')::integer)
      from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
      where item.value #>> '{subject,operation}' = 'create' and not (item.value #> '{meta,recordType}' ? 'systemProjection')
    ));
  end if;
  select coalesce(pg_catalog.array_agg((item.value ->> 'index')::integer order by (item.value ->> 'index')::integer), array[]::integer[]),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'recordTypeId', item.value #> '{subject,recordTypeId}', 'recordId', item.value #> '{subject,recordId}'
    ) order by (item.value ->> 'index')::integer), '[]'::jsonb)
  into update_indexes, update_targets
  from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
  where item.value #>> '{subject,operation}' = 'update' and not (item.value #> '{meta,recordType}' ? 'systemProjection')
    and (item.value -> 'action' is null or item.value -> 'action' = 'null'::jsonb);
  if pg_catalog.cardinality(update_indexes) > 0 then
    loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
    if preview_installation is null then
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'declaration', plan_item.value #> '{meta,declaration}',
          'recordId', update_targets -> (loaded.ordinality - 1)::integer -> 'recordId',
          'facts', (loaded.value -> 'facts') || pg_catalog.jsonb_build_object('binding', plan_item.value #> '{meta,declaration,recordBinding}')
        ) order by loaded.ordinality)
      into decision_set
      from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality)
      join (
        select item.value, row_number() over (order by (item.value ->> 'index')::integer) as plan_position
        from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
        where item.value #>> '{subject,operation}' = 'update' and not (item.value #> '{meta,recordType}' ? 'systemProjection')
          and (item.value -> 'action' is null or item.value -> 'action' = 'null'::jsonb)
      ) as plan_item on plan_item.plan_position = loaded.ordinality
      where loaded.value ->> 'outcome' = 'loaded';
      if decision_set is not null then
        decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
      end if;
    end if;
    set_position := 0;
    for target_position in 1 .. pg_catalog.jsonb_array_length(loaded_set) loop
      update_loaded[update_indexes[target_position] + 1] := loaded_set -> (target_position - 1);
      if loaded_set -> (target_position - 1) ->> 'outcome' = 'loaded' and preview_installation is null then
        update_decisions[update_indexes[target_position] + 1] := decision_set -> set_position;
        set_position := set_position + 1;
      end if;
    end loop;
  end if;
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    order by (item.value ->> 'index')::integer
  loop
    subject := plan -> 'subject';
    prepared := plan -> 'prepared';
    meta := plan -> 'meta';
    if meta -> 'recordType' ? 'systemProjection' then
      result_value := vortex_access.change_organization_settings_record_internal(
        (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
        prepared -> 'coreValues', prepared -> 'extensionValues'
      );
      if result_value ->> 'outcome' is distinct from 'saved' then
        raise exception using errcode = '40001', message = 'Prepared settings record change was refused';
      end if;
      results := results || pg_catalog.jsonb_build_array(result_value || pg_catalog.jsonb_build_object(
        'recordId', subject -> 'recordId'
      ));
      continue;
    end if;
    if subject ->> 'operation' in ('create', 'update') then
      -- A different intent may have deleted or changed a link target since its
      -- preparation. Recheck target eligibility against the completed graph.
      for relationship_value in
        select item.value from pg_catalog.jsonb_array_elements(meta #> '{recordType,relationships}') as item(value)
        where (subject -> 'finalValues') ? (item.value ->> 'fromFieldId')
      loop
        perform vortex_record.prepare_relationship_value_internal(
          (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid,
          (relationship_value ->> 'relationshipId')::uuid,
          subject -> 'finalValues' -> (relationship_value ->> 'fromFieldId'), false,
          case when plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb
            then plan -> 'action' else null end
        );
      end loop;
    end if;
    if subject ->> 'operation' = 'create' then
      result_value := create_results -> (pg_catalog.array_position(create_indexes, (plan ->> 'index')::integer) - 1);
    elsif subject ->> 'operation' = 'update' then
      if plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb then
        loaded := vortex_record.load_named_action_facts_internal(
          plan #>> '{action,ownerKind}', (plan #>> '{action,ownerId}')::uuid,
          (plan #>> '{action,releaseRevision}')::bigint, (plan #>> '{action,actionId}')::uuid,
          (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid, null
        );
      else
        loaded := update_loaded[(plan ->> 'index')::integer + 1];
      end if;
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '42501', message = 'Changed record is unavailable';
      end if;
      if preview_installation is null then
        decision := case when plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb
          then (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', meta -> 'declaration', 'recordId', (subject ->> 'recordId')::uuid, 'facts', (loaded -> 'facts') || pg_catalog.jsonb_build_object('binding', meta #> '{declaration,recordBinding}')))) -> 0)
          else update_decisions[(plan ->> 'index')::integer + 1] end;
        if decision ->> 'outcome' is distinct from 'allowed' then
          raise exception using errcode = '42501', message = 'Changed record is unavailable';
        end if;
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
      else
        bounds := vortex_record.preview_record_field_bounds_internal(
          (subject ->> 'recordTypeId')::uuid, (meta ->> 'storageContractId')::uuid, meta -> 'recordType'
        );
        if bounds is null then
          raise exception using errcode = '42501', message = 'Changed record is unavailable';
        end if;
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key)
        where not (bounds -> 'changeableFieldIds') ? field.key
      ) then
        raise exception using errcode = '42501', message = 'Changed field is unavailable';
      end if;
      result_value := prepared - array['storageChange', 'edgeChanges']::text[];
    else
      result_value := pg_catalog.jsonb_build_object(
        'outcome', case subject ->> 'operation' when 'delete' then 'deleted' else 'restored' end,
        'recordId', subject -> 'recordId',
        'concurrencyNumber', (subject ->> 'expectedConcurrencyNumber')::bigint + 1
      );
    end if;
    results := results || pg_catalog.jsonb_build_array(result_value);
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', results, 'written', written);
end
$function$;
alter function vortex_record.apply_prepared_record_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_prepared_record_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_prepared_record_set_internal(jsonb) is
  'Private prepared-set persistence: one physical write per storage table and one edge write, followed by current authority and relationship checks over the complete graph; any refusal aborts the set.';

reset role;
