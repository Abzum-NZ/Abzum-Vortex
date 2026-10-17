-- One signature per function: the canonical sources already declare a single form of each
-- function, so the database drops the narrower overloads that delegated to it and reinstalls the
-- callers that used them, including the dynamic references that named a reader's older argument
-- list. Every changed function is reinstalled before the overloads it no longer names are dropped,
-- and no compatibility path remains: one name has one signature.
set local role vortex_owner;

create or replace function vortex_access.list_visible_person_link_labels(p_record_ids uuid[])
returns table (record_id uuid, display_name text)
language sql
volatile
security definer
set search_path = ''
as $function$
  select person.record_id, person.attribute_values ->> 'display_name'
  from vortex_access.list_organization_accounts_projection(
    p_record_ids, 'record_id', 'ascending', null, null
  ) as person
  where person.record_id = any(p_record_ids)
    and pg_catalog.length(pg_catalog.btrim(person.attribute_values ->> 'display_name')) > 0
$function$;

revoke all on function vortex_access.list_visible_person_link_labels(uuid[])
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_access.list_visible_person_link_labels(uuid[]) to vortex_request;

comment on function vortex_access.list_visible_person_link_labels(uuid[]) is
  'Returns labels only for the requested people visible through the current viewer-permitted directory projection.';

alter function vortex_access.list_visible_person_link_labels(uuid[]) owner to vortex_owner;

grant execute on function vortex_access.list_visible_person_link_labels(uuid[]) to postgres;

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
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
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
          target_record_type_id, 'read', target_record_id, null, null::jsonb
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

create or replace function vortex_record.apply_settings_record_changes_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  receipt_claim jsonb;
  access_result jsonb;
  projection jsonb;
  event_result jsonb;
  correlation_id_value uuid;
  application_root_id_value uuid;
  notice_sequence bigint;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    if p_command_id is not null then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value ->> 'key' is distinct from 'organization_settings'
    or record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not vortex_definition.is_system_projection_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  application_root_id_value := (meta -> 'context' ->> 'applicationRootId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null, null::jsonb
  );
  if loaded ->> 'outcome' <> 'loaded' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := meta #>> array['columns', field_id, 'databaseValueType'];
    if database_type is null then
      raise exception using errcode = '55000',
        message = 'Organization settings field storage is unavailable';
    end if;

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' = 'completed' then
      projection := vortex_record.read_record(p_record_type_id, p_record_id);
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', correlation_id_value
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'saved',
        'recordId', projection -> 'recordId',
        'concurrencyNumber', projection -> 'concurrencyNumber',
        'values', projection -> 'values',
        'correlationId', correlation_id_value,
        'backgroundDelivery', 'pending',
        'replayed', true
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'none' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'reasonCode', 'command_pending',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'record_revision_conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', correlation_id_value
    );
  end if;

  access_result := vortex_access.change_organization_settings_record_internal(
    p_record_id, p_expected_concurrency_number, core_values, extension_values
  );
  if access_result ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return access_result || pg_catalog.jsonb_build_object(
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_conflict'),
      'correlationId', correlation_id_value
    );
  end if;
  if access_result ->> 'outcome' <> 'saved' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_refused'),
      'correlationId', correlation_id_value
    );
  end if;

  perform vortex_record.append_base_save_activity_internal(
    p_activity_id, 'update', p_record_id, changed_field_ids, 'completed'
  );
  event_result := vortex_platform.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Organization settings Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id,
    (access_result ->> 'concurrencyNumber')::bigint,
    'Organization settings record save receipt is stale'
  );
  projection := vortex_record.read_record(p_record_type_id, p_record_id);
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved organisation settings projection is unavailable';
  end if;
  begin
    notice_sequence := pg_catalog.nextval(
      'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
    );
    perform vortex_platform.publish_change_notice(
      p_record_id, application_root_id_value, p_record_type_id,
      p_record_id, (access_result ->> 'concurrencyNumber')::bigint, 'changed',
      notice_sequence, notice_sequence, correlation_id_value
    );
  exception when others then
    -- Invalidation is advisory after the protected settings change completes,
    -- but its failure is logged with the cause so a stale view can be diagnosed.
    raise warning 'RECORD_INVALIDATION_FAILED settings record %: % %',
      p_record_id, sqlstate, sqlerrm;
  end;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save conflicted: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'database_conflict_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save refused: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'database_refused_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
end
$function$;

alter function vortex_record.apply_settings_record_changes_internal(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Internal settings change reached only through apply_record_changes: rechecks the installed system projection, protected permission and revision, then writes once with one Activity, Event and change notice.';

alter function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

create or replace function vortex_record.authorize_created_records_for_command_internal(
  p_creations jsonb,
  p_created_records jsonb,
  p_original_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  safe_integer_max constant bigint := 9007199254740991;
  current_context jsonb;
  meta jsonb;
  meta_context jsonb;
  loaded jsonb;
  loaded_context jsonb;
  facts jsonb;
  record_fact jsonb;
  record_scope jsonb;
  decision jsonb;
  bounds jsonb;
  creation jsonb;
  created_value jsonb;
  saved_tuple jsonb;
  submitted_field text;
  returned_field text;
  submitted_id uuid;
  changeable_id text;
  ordinal_key text;
  ordinal_value integer;
  record_type_id_value uuid;
  record_id_value uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  module_root_id_value uuid;
  storage_contract_id_value uuid;
  module_release_revision_value bigint;
  definition_revision_value bigint;
  storage_scope_value text;
  actual_concurrency_number bigint;
  expected_record_scope jsonb;
  ordinals integer[] := array[]::integer[];
  seen_map_ordinals integer[] := array[]::integer[];
  seen_record_ids uuid[] := array[]::uuid[];
  result_tuples jsonb := '[]'::jsonb;
  matching_target_count integer;
  eligible_value boolean;
begin
  if pg_catalog.jsonb_typeof(p_creations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_created_records) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_original_context) is distinct from 'object'
    or not (p_original_context ?& array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ])
    or p_original_context - array[
      'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
    ]::text[] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_creations) = 0
    or (select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(p_created_records)) <>
      pg_catalog.jsonb_array_length(p_creations) then
    raise exception using errcode = '22023',
      message = 'Named action creation authority input is invalid';
  end if;
  if pg_catalog.jsonb_typeof(p_original_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_original_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(p_original_context ->> 'correlationId', 'uuid'), true) then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;
  organization_id_value := (p_original_context ->> 'organizationId')::uuid;
  application_root_id_value := (p_original_context ->> 'applicationRootId')::uuid;
  account_id_value := (p_original_context ->> 'organizationAccountId')::uuid;
  correlation_id_value := (p_original_context ->> 'correlationId')::uuid;
  if organization_id_value = nil_uuid or application_root_id_value = nil_uuid
    or account_id_value = nil_uuid or correlation_id_value = nil_uuid then
    raise exception using errcode = '42501',
      message = 'Named action creation context is unavailable';
  end if;

  current_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(current_context) is distinct from 'object'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'applicationRootId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(current_context -> 'correlationId') is distinct from 'string'
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'applicationRootId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'organizationAccountId', 'uuid'), true)
    or coalesce(not pg_catalog.pg_input_is_valid(current_context ->> 'correlationId', 'uuid'), true)
    or (current_context ->> 'organizationId')::uuid is distinct from organization_id_value
    or (current_context ->> 'applicationRootId')::uuid is distinct from application_root_id_value
    or (current_context ->> 'organizationAccountId')::uuid is distinct from account_id_value
    or (current_context ->> 'correlationId')::uuid is distinct from correlation_id_value then
    raise exception using errcode = '42501',
      message = 'Named action creation context changed';
  end if;

  -- Validate and retain each canonical ordinal before using it as an object key.
  for creation in
    select item.value from pg_catalog.jsonb_array_elements(p_creations) item(value)
  loop
    if pg_catalog.jsonb_typeof(creation) is distinct from 'object'
      or not (creation ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
      or creation - array['ordinal', 'recordTypeId', 'values', 'finalValues']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(creation -> 'ordinal') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'ordinal', 'integer'), true)
      or pg_catalog.jsonb_typeof(creation -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(creation ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(creation -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(creation -> 'finalValues') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation authority input is invalid';
    end if;
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    if ordinal_value < 0 or record_type_id_value = nil_uuid
      or ordinal_value = any (ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation ordinal is invalid';
    end if;
    ordinals := pg_catalog.array_append(ordinals, ordinal_value);
  end loop;

  -- A JSON object can contain text keys such as "01" and "1" that cast to the
  -- same integer. Admit only the exact decimal form of each declared ordinal.
  for ordinal_key in
    select item.key from pg_catalog.jsonb_object_keys(p_created_records) item(key)
  loop
    if coalesce(not pg_catalog.pg_input_is_valid(ordinal_key, 'integer'), true) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    ordinal_value := ordinal_key::integer;
    if ordinal_value < 0 or ordinal_key is distinct from ordinal_value::text
      or not (ordinal_value = any (ordinals))
      or ordinal_value = any (seen_map_ordinals) then
      raise exception using errcode = '22023',
        message = 'Named action creation result key is invalid';
    end if;
    seen_map_ordinals := pg_catalog.array_append(seen_map_ordinals, ordinal_value);
  end loop;
  if pg_catalog.cardinality(seen_map_ordinals) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '22023',
      message = 'Named action creation result set is incomplete';
  end if;

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
    order by (item.value ->> 'ordinal')::integer
  loop
    ordinal_value := (creation ->> 'ordinal')::integer;
    record_type_id_value := (creation ->> 'recordTypeId')::uuid;
    created_value := p_created_records -> ordinal_value::text;
    if pg_catalog.jsonb_typeof(created_value) is distinct from 'object'
      or not (created_value ?& array['recordId', 'storageContractId', 'values', '_savedTuple'])
      or created_value - array['recordId', 'storageContractId', 'values', '_savedTuple']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(created_value -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(created_value ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(created_value -> 'values') is distinct from 'object'
      or pg_catalog.jsonb_typeof(created_value -> '_savedTuple') is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Named action creation result is invalid';
    end if;
    record_id_value := (created_value ->> 'recordId')::uuid;
    storage_contract_id_value := (created_value ->> 'storageContractId')::uuid;
    saved_tuple := created_value -> '_savedTuple';
    if record_id_value = nil_uuid or storage_contract_id_value = nil_uuid
      or pg_catalog.jsonb_typeof(saved_tuple) is distinct from 'object'
      or not (saved_tuple ?& array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ])
      or saved_tuple - array[
        'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
        'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
        'storageScope', 'actorId', 'correlationId', 'eligible'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'organizationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'organizationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') not in ('string', 'null')
      or (pg_catalog.jsonb_typeof(saved_tuple -> 'applicationRootId') = 'string'
        and coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'applicationRootId', 'uuid'), true))
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleRootId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleRootId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'recordTypeId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'recordTypeId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageContractId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'storageContractId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(saved_tuple -> 'actorId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'actorId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(saved_tuple ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(saved_tuple -> 'eligible') is distinct from 'boolean' then
      raise exception using errcode = '22023',
        message = 'Named action creation tuple is invalid';
    end if;

    if (saved_tuple ->> 'recordId')::uuid is distinct from record_id_value
      or (saved_tuple ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (saved_tuple ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (saved_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
      or (saved_tuple ->> 'actorId')::uuid is distinct from account_id_value
      or (saved_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (saved_tuple ->> 'concurrencyNumber')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and safe_integer_max
      or (saved_tuple ->> 'moduleRootId')::uuid = nil_uuid
      or (saved_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
      or ((saved_tuple ->> 'storageScope') = 'application_contained'
        and (saved_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
      or ((saved_tuple ->> 'storageScope') = 'organization_shared'
        and saved_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
      or (saved_tuple ->> 'eligible')::boolean is distinct from
        ((saved_tuple ->> 'storageScope') = 'application_contained') then
      raise exception using errcode = '42501',
        message = 'Named action creation tuple context changed';
    end if;
    if record_id_value = any (seen_record_ids) then
      raise exception using errcode = '22023',
        message = 'Named action creation identity is duplicated';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, record_id_value);

    meta := vortex_record.resolve_record_action_context_internal(record_type_id_value, 'create');
    if pg_catalog.jsonb_typeof(meta) is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'context') is distinct from 'object'
      or meta ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(meta -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'storageContractId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'context' -> 'correlationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'recordTypeId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'recordType' -> 'storageScope') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(meta -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'context' ->> 'correlationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta -> 'recordType' ->> 'recordTypeId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(
        meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId', 'uuid'
      ), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'storageContractId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(meta ->> 'moduleReleaseRevision', 'bigint'), true)
      or meta ->> 'storageScope' is distinct from saved_tuple ->> 'storageScope'
      or (meta ->> 'moduleRootId')::uuid is distinct from (saved_tuple ->> 'moduleRootId')::uuid
      or (meta ->> 'storageContractId')::uuid is distinct from storage_contract_id_value
      or (meta ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint
      or (meta -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (meta -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (meta -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (meta -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or (meta -> 'recordType' ->> 'recordTypeId')::uuid is distinct from record_type_id_value
      or (meta -> 'recordType' ->> 'storageScope') is distinct from saved_tuple ->> 'storageScope'
      or (meta -> 'declaration' -> 'recordBinding' ->> 'moduleRootId')::uuid is distinct from
        (saved_tuple ->> 'moduleRootId')::uuid
      or (meta -> 'declaration' -> 'recordBinding' ->> 'recordTypeId')::uuid is distinct from
        record_type_id_value
      or (meta -> 'declaration' -> 'recordBinding' ->> 'storageContractId')::uuid is distinct from
        storage_contract_id_value
      or meta -> 'declaration' -> 'recordBinding' ->> 'storageScope' is distinct from
        saved_tuple ->> 'storageScope' then
      raise exception using errcode = '42501',
        message = 'Named action creation installation is unavailable';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_each(creation -> 'finalValues') expected(key, value)
      where not (created_value -> 'values' ? expected.key)
        or (created_value -> 'values' -> expected.key) is distinct from expected.value
    ) then
      raise exception using errcode = '55000',
        message = 'Named action creation values changed';
    end if;
    for returned_field in
      select key from pg_catalog.jsonb_object_keys(created_value -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(returned_field, 'uuid'), true)
        or not (meta -> 'columns' ? pg_catalog.lower(returned_field)) then
        raise exception using errcode = '55000',
          message = 'Named action creation values are unavailable';
      end if;
      if not (creation -> 'finalValues' ? returned_field)
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') field(value)
          where pg_catalog.lower(field.value ->> 'fieldId') =
              pg_catalog.lower(returned_field)
            and field.value ->> 'type' = 'reference_number'
        ) then
        raise exception using errcode = '55000',
          message = 'Named action creation generated value is unavailable';
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      record_type_id_value, 'create', record_id_value, null, null::jsonb
    );
    if pg_catalog.jsonb_typeof(loaded) is distinct from 'object'
      or loaded ->> 'outcome' is distinct from 'loaded'
      or loaded ? 'previewInstallationId'
      or pg_catalog.jsonb_typeof(loaded -> 'context') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'applicationRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'organizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'context' -> 'correlationId') is distinct from 'string'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'applicationRootId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'organizationAccountId', 'uuid'), true)
      or coalesce(not pg_catalog.pg_input_is_valid(loaded -> 'context' ->> 'correlationId', 'uuid'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration' -> 'recordBinding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'records') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'recordTypes') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'relationships') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'sharingConditions') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'edges') is distinct from 'array'
      or pg_catalog.jsonb_typeof(loaded -> 'facts' -> 'binding') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'columns') is distinct from 'object'
      or pg_catalog.jsonb_typeof(loaded -> 'table') is distinct from 'string'
      or pg_catalog.jsonb_typeof(loaded -> 'concurrencyNumber') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'concurrencyNumber', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'definitionRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'definitionRevision', 'bigint'), true)
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(loaded -> 'moduleReleaseRevision') is distinct from 'number'
      or coalesce(not pg_catalog.pg_input_is_valid(loaded ->> 'moduleReleaseRevision', 'bigint'), true)
      or (loaded -> 'context' ->> 'organizationId')::uuid is distinct from organization_id_value
      or (loaded -> 'context' ->> 'applicationRootId')::uuid is distinct from application_root_id_value
      or (loaded -> 'context' ->> 'organizationAccountId')::uuid is distinct from account_id_value
      or (loaded -> 'context' ->> 'correlationId')::uuid is distinct from correlation_id_value
      or loaded -> 'facts' -> 'binding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded -> 'declaration' -> 'recordBinding' is distinct from
        meta -> 'declaration' -> 'recordBinding'
      or loaded ->> 'table' is distinct from meta ->> 'table'
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (meta ->> 'moduleReleaseRevision')::bigint
      or (loaded ->> 'moduleReleaseRevision')::bigint is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation facts are unavailable';
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'relationships') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'sharingConditions') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'edges') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation graph facts are malformed';
    end if;
    actual_concurrency_number := (loaded ->> 'concurrencyNumber')::bigint;
    definition_revision_value := (loaded ->> 'definitionRevision')::bigint;
    if actual_concurrency_number not between 1 and safe_integer_max then
      raise exception using errcode = '55000',
        message = 'Named action creation revision is unavailable';
    end if;
    if definition_revision_value not between 1 and safe_integer_max
      or definition_revision_value is distinct from
        (saved_tuple ->> 'moduleReleaseRevision')::bigint then
      raise exception using errcode = '42501',
        message = 'Named action creation definition changed';
    end if;

    matching_target_count := 0;
    record_fact := null;
    for record_fact in
      select item.value from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    loop
      if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'recordScope') is distinct from 'object'
        or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object' then
        raise exception using errcode = '55000',
          message = 'Named action creation target facts are malformed';
      end if;
      if pg_catalog.jsonb_typeof(record_fact -> 'recordScope' -> 'recordId') = 'string'
        and coalesce(pg_catalog.pg_input_is_valid(
          record_fact -> 'recordScope' ->> 'recordId', 'uuid'
        ), false)
        and (record_fact -> 'recordScope' ->> 'recordId')::uuid = record_id_value then
        matching_target_count := matching_target_count + 1;
      end if;
    end loop;
    if matching_target_count <> 1 then
      raise exception using errcode = '42501',
        message = 'Named action creation target is unavailable';
    end if;

    -- Re-read the one exact saved target from the returned fact set and compare
    -- its complete loader-produced scope; related graph facts never substitute.
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
    where item.value -> 'recordScope' ->> 'recordId' = record_id_value::text;
    record_scope := record_fact -> 'recordScope';
    expected_record_scope := pg_catalog.jsonb_build_object(
      'storageScope', saved_tuple ->> 'storageScope',
      'organizationId', organization_id_value,
      'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
      'recordTypeId', record_type_id_value,
      'storageContractId', storage_contract_id_value,
      'recordId', record_id_value
    ) || case when saved_tuple ->> 'storageScope' = 'application_contained'
      then pg_catalog.jsonb_build_object('applicationRootId', application_root_id_value)
      else '{}'::jsonb end;
    if record_scope is distinct from expected_record_scope
      or pg_catalog.jsonb_typeof(record_fact -> 'fieldValues') is distinct from 'object'
      or record_fact ->> 'lifecycleState' is distinct from 'active' then
      raise exception using errcode = '42501',
        message = 'Named action creation target scope changed';
    end if;

    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if pg_catalog.jsonb_typeof(decision) is distinct from 'object'
      or decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501',
        message = 'Named action creation authority is unavailable';
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    if pg_catalog.jsonb_typeof(bounds) is distinct from 'object'
      or pg_catalog.jsonb_typeof(bounds -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(bounds -> 'changeableFieldIds') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
      )
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or coalesce(not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid'), true)
          or not (bounds -> 'readableFieldIds' ? (item.value #>> '{}'))
      ) then
      raise exception using errcode = '55000',
        message = 'Named action creation field bounds are unavailable';
    end if;
    for submitted_field in
      select key from pg_catalog.jsonb_object_keys(creation -> 'values') as field(key)
    loop
      if coalesce(not pg_catalog.pg_input_is_valid(submitted_field, 'uuid'), true) then
        raise exception using errcode = '22023',
          message = 'Named action creation field is invalid';
      end if;
      submitted_id := submitted_field::uuid;
      changeable_id := pg_catalog.lower(submitted_id::text);
      if not (meta -> 'columns' ? changeable_id)
        or not exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(bounds -> 'changeableFieldIds') item(value)
          where pg_catalog.lower(item.value) = changeable_id
        ) then
        raise exception using errcode = '42501',
          message = 'Named action creation field is not changeable';
      end if;
    end loop;

    eligible_value := (saved_tuple ->> 'eligible')::boolean;
    result_tuples := result_tuples || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', ordinal_value,
        'recordId', record_id_value,
        'concurrencyNumber', actual_concurrency_number,
        'organizationId', organization_id_value,
        'applicationRootId', saved_tuple -> 'applicationRootId',
        'moduleRootId', (saved_tuple ->> 'moduleRootId')::uuid,
        'recordTypeId', record_type_id_value,
        'storageContractId', storage_contract_id_value,
        'moduleReleaseRevision', (loaded ->> 'moduleReleaseRevision')::bigint,
        'storageScope', saved_tuple ->> 'storageScope',
        'correlationId', correlation_id_value,
        'eligible', eligible_value
      )
    );
  end loop;

  if pg_catalog.jsonb_array_length(result_tuples) <> pg_catalog.cardinality(ordinals)
    or pg_catalog.cardinality(seen_record_ids) <> pg_catalog.cardinality(ordinals) then
    raise exception using errcode = '55000',
      message = 'Named action creation authority result is incomplete';
  end if;
  return result_tuples;
end
$function$;

alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;

alter function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb) is
  'Private named-action whole-graph ordinary CREATE authorization barrier over the complete inserted set; revalidates the original HUMAN context, installed scope, actual loader target and revision, current Access decision and submitted field bounds, returning ordered final saved tuples for the terminal receipt and created-notice seam.';

create or replace function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
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
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  if not (loaded ? 'previewInstallationId') then
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  end if;

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ','),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

alter function vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[]) owner to vortex_record_adapter;

alter function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed owner-only record update primitive. It checks one live record decision or the exact owner preview address, validates values and field bounds before writing, enforces concurrency, and returns only its permitted field projection.';

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
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
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
        or new_concurrency not between 1 and 9007199254740991 then
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
    );
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

alter function vortex_record.change_record_relationship_internal(uuid,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;

alter function vortex_record.change_record_relationship_internal(uuid,uuid,bigint,uuid,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.change_record_relationship_internal(uuid, uuid, bigint, uuid, jsonb) is
  'Private revision-checked relationship primitive: decides source update and target eligibility, changes the edge atomically, and returns the actual saved identity, revision for the live application-contained copy owner to publish.';

create or replace function vortex_record.create_record_internal(
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
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
  exact_create_notice boolean := false;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
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
    exact_create_notice := preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and case when pg_catalog.jsonb_typeof(record_type_value -> 'relationships') = 'array'
        then true
        else false end;

    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
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

      column_names := pg_catalog.array_append(
        column_names, pg_catalog.format('%I', column_value ->> 'token')
      );
      column_values := pg_catalog.array_append(column_values,
        case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
          when 'timestamp_with_time_zone' then
            pg_catalog.format('%L::timestamptz', input_value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
          else pg_catalog.format('%L::text', input_value #>> '{}')
        end end
      );
    end loop;

    insert_sql := pg_catalog.format(
      'insert into record_data.%I (
         organisation_id, module_root_id, record_type_id, storage_contract_id,
         record_id, application_root_id, definition_revision,
         owner_organisation_account_id, owner_group_id, lifecycle_state,
         concurrency_number, created_at, created_by, updated_at, updated_by%s
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
         pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)',
      meta ->> 'table',
      case when pg_catalog.cardinality(column_names) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
      case when pg_catalog.cardinality(column_values) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_values, ', ') end
    );
    if exact_create_notice then
      execute insert_sql || ' returning record_id, concurrency_number'
        into strict saved_record_id, saved_concurrency_number
        using
          (context_value ->> 'organizationId')::uuid,
          (meta ->> 'moduleRootId')::uuid, p_record_type_id,
          (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
          (meta ->> 'moduleReleaseRevision')::bigint,
          owner_account_id, owner_group_id,
          (context_value ->> 'organizationAccountId')::uuid;
      record_id_value := saved_record_id;
    else
      execute insert_sql using
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'moduleRootId')::uuid, p_record_type_id,
        (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
        (meta ->> 'moduleReleaseRevision')::bigint,
        owner_account_id, owner_group_id,
        (context_value ->> 'organizationAccountId')::uuid;
    end if;

    -- #1061: the canonical link-target share-lock prelude is written once in
    -- lock_record_change_targets_internal. Every created link's target row is
    -- locked here, before the data-version bump and edge pass below, so a
    -- multi-link create takes all its row locks before its data version and any
    -- edge identity, as the update writer does. A malformed or undeclared link
    -- is left to the writer's own validation.
    perform vortex_record.lock_record_change_targets_internal(
      record_type_value, (context_value ->> 'organizationId')::uuid, final_values
    );
    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    if exact_create_notice then
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
    else
      perform vortex_record.bump_record_data_version_internal(
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'storageContractId')::uuid, app_scope
      );
    end if;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, record_id_value,
          (relationship_value ->> 'relationshipId')::uuid,
          final_values -> pg_catalog.lower(field_id_value::text), false
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'create', record_id_value, null, null::jsonb
    );
    if loaded ->> 'outcome' <> 'loaded' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', record_id_value, facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        refusal_reason := 'access_refused';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        refusal_reason := 'record_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := preview_bounds;
    end if;
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    foreach submitted_id in array p_submitted_field_ids loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    if exact_create_notice then
      begin
        perform vortex_platform.publish_change_notice(
          (context_value ->> 'organizationId')::uuid, app_scope, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'created',
          notice_sequence, notice_sequence,
          (context_value ->> 'correlationId')::uuid
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the create.
          null;
      end;
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', case when exact_create_notice
        then saved_concurrency_number else 1 end, 'values', final_values
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

alter function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid) is
  'Private fixed create primitive: derives scope, definition and human ownership, generates references, writes typed values and relationships, and decides create authority over the proposed record in one rollback-safe transaction.';

create or replace function vortex_record.create_system_projection_companion_storage_internal(
  p_storage_contract_id uuid,
  p_target_module_root_id uuid,
  p_record_type_id uuid,
  p_contributor_module_root_id uuid,
  p_field_definition jsonb,
  p_validate_only boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_id_value uuid;
  database_type text;
  sql_type text;
  table_token text;
  column_token text;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  view_oid oid;
  reader_function_oid oid;
  relation_oid oid;
  owner_role_oid oid := 'vortex_owner'::regrole::oid;
  adapter_role_oid oid := 'vortex_record_adapter'::regrole::oid;
  has_mapping boolean;
  expected_columns text[];
  existing_columns text[];
  acl_adapter_count integer;
  acl_adapter_invalid_count integer;
  acl_other_count integer;
  policy_expression text;
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_target_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_contributor_module_root_id::text)
    or p_target_module_root_id = p_contributor_module_root_id
    or pg_catalog.jsonb_typeof(p_field_definition) is distinct from 'object'
    or p_validate_only is null then
    raise exception using errcode = '22023',
      message = 'Projection companion storage identity is invalid';
  end if;

  begin
    field_id_value := (p_field_definition ->> 'fieldId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Projection companion field identity is invalid';
  end;
  if not vortex_platform.is_non_nil_uuid(field_id_value::text)
    or p_field_definition -> 'required' is distinct from 'false'::jsonb
    or p_field_definition -> 'unique' is distinct from 'false'::jsonb
    or p_field_definition -> 'filterable' is distinct from 'false'::jsonb
    or p_field_definition -> 'sortable' is distinct from 'false'::jsonb then
    raise exception using errcode = '23514',
      message = 'A system projection contribution must be optional and unindexed';
  end if;
  database_type := vortex_record.database_value_type(p_field_definition);
  sql_type := vortex_record.sql_value_type(database_type);
  if database_type is null or sql_type is null
    or pg_catalog.to_regtype(sql_type) is null then
    raise exception using errcode = '23514',
      message = 'Contributed field type is unsupported';
  end if;

  select catalogue.* into strict catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
  for update;
  protected_view_key := catalogue_row.protected_read_model_key;
  table_token := 'cp_' || pg_catalog.replace(
    pg_catalog.lower(p_storage_contract_id::text), '-', ''
  );
  column_token := 'f_' || pg_catalog.replace(
    pg_catalog.lower(field_id_value::text), '-', ''
  );
  if catalogue_row.module_root_id <> p_target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from 'organization_shared'
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'system_projection'
    or catalogue_row.physical_table_token is distinct from
      ('rt_' || pg_catalog.replace(pg_catalog.lower(p_storage_contract_id::text), '-', ''))
    or protected_view_key is null then
    raise exception using errcode = '55000',
      message = 'Target record storage lineage is incompatible';
  end if;

  select registered.reader_schema, registered.reader_function
  into reader_schema_value, reader_function_value
  from vortex_record.protected_read_model_views as registered
  where registered.protected_read_model_key = protected_view_key;
  if not found then
    raise exception using errcode = '55000',
      message = 'Protected projection view is unavailable';
  end if;
  view_oid := pg_catalog.to_regclass(pg_catalog.format(
    '%I.%I', 'record_data', catalogue_row.physical_table_token
  ))::oid;
  reader_function_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.%I(uuid[],text,text,jsonb,integer)', reader_schema_value, reader_function_value
  ))::oid;
  if view_oid is null
    or reader_function_oid is null
    or not exists (
      select 1
      from pg_catalog.pg_class as relation
      where relation.oid = view_oid
        and relation.relkind = 'v'
        and relation.relowner = owner_role_oid
    )
    or exists (
      select 1 from pg_catalog.pg_trigger as trigger
      where trigger.tgrelid = view_oid and not trigger.tgisinternal
    )
    or exists (
      select 1 from pg_catalog.pg_rewrite as rule
      where rule.ev_class = view_oid and rule.rulename <> '_RETURN'
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.pg_rewrite as rule
      join pg_catalog.pg_depend as dependency
        on dependency.classid = 'pg_rewrite'::regclass
        and dependency.objid = rule.oid
        and dependency.refclassid = 'pg_proc'::regclass
      where rule.ev_class = view_oid and rule.rulename = '_RETURN'
    ) <> 1
    or exists (
      select 1
      from pg_catalog.pg_rewrite as rule
      join pg_catalog.pg_depend as dependency
        on dependency.classid = 'pg_rewrite'::regclass
        and dependency.objid = rule.oid
        and dependency.refclassid = 'pg_class'::regclass
      where rule.ev_class = view_oid and rule.rulename = '_RETURN'
        and dependency.refobjid <> view_oid
    )
    or not exists (
      select 1 from pg_catalog.pg_proc as reader
      where reader.oid = reader_function_oid and reader.prosecdef
    )
    or not exists (
      select 1
      from pg_catalog.pg_rewrite as rule
      join pg_catalog.pg_depend as dependency
        on dependency.classid = 'pg_rewrite'::regclass
        and dependency.objid = rule.oid
        and dependency.refclassid = 'pg_proc'::regclass
        and dependency.refobjid = reader_function_oid
      where rule.ev_class = view_oid and rule.rulename = '_RETURN'
    ) then
    raise exception using errcode = '55000',
      message = 'Protected projection view lineage is incompatible';
  end if;

  select mapping.* into mapping_row
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.field_id = field_id_value
  for update;
  has_mapping := found;
  if has_mapping then
    if mapping_row.introduced_by_module_root_id <> p_contributor_module_root_id
      or mapping_row.physical_column_token <> column_token
      or mapping_row.database_value_type <> database_type
      or mapping_row.state not in ('active', 'retired')
      or vortex_record.field_storage_meaning(mapping_row.field_definition)
        is distinct from vortex_record.field_storage_meaning(p_field_definition) then
      raise exception using errcode = '55000',
        message = 'Existing contributed field storage is incompatible';
    end if;
  end if;

  if exists (
    select 1
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.introduced_by_module_root_id <> p_target_module_root_id
      and mapping.state not in ('active', 'retired')
  ) then
    raise exception using errcode = '55000',
      message = 'Existing contributed field storage is incompatible';
  end if;
  select coalesce(
      pg_catalog.array_agg(mapping.physical_column_token order by mapping.physical_column_token),
      array[]::text[]
    )
  into expected_columns
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_storage_contract_id
    and mapping.introduced_by_module_root_id <> p_target_module_root_id;

  relation_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token))::oid;
  if relation_oid is null then
    if has_mapping or pg_catalog.cardinality(expected_columns) > 0 then
      raise exception using errcode = '55000',
        message = 'Existing contributed field storage is incompatible';
    end if;
    if p_validate_only then
      return;
    end if;
    execute pg_catalog.format(
      'create table record_data.%I (
        organisation_id uuid not null,
        record_id uuid not null,
        %I %s,
        primary key (organisation_id, record_id)
      )', table_token, column_token, sql_type
    );
    execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
    execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
    execute pg_catalog.format(
      'create policy projection_companion_record_access on record_data.%I
        for all to vortex_record_adapter
        using (organisation_id = vortex_platform.organization_id())
        with check (organisation_id = vortex_platform.organization_id())', table_token
    );
    execute pg_catalog.format(
      'revoke all on record_data.%I from public, anon, authenticated, service_role,
        vortex_runtime, vortex_request, vortex_owner', table_token
    );
    execute pg_catalog.format(
      'grant select, insert, update on record_data.%I to vortex_record_adapter', table_token
    );
    expected_columns := expected_columns || column_token;
  else
    if not exists (
      select 1
      from pg_catalog.pg_class as relation
      where relation.oid = relation_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and not relation.relispartition
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    )
      or exists (
        select 1 from pg_catalog.pg_inherits as inheritance
        where inheritance.inhrelid = relation_oid
      )
      or exists (
        select 1 from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid = relation_oid and not trigger.tgisinternal
      )
      or exists (
        select 1 from pg_catalog.pg_rewrite as rule
        where rule.ev_class = relation_oid
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;
    select coalesce(
        pg_catalog.array_agg(attribute.attname order by attribute.attname),
        array[]::text[]
      )
    into existing_columns
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = relation_oid
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname not in ('organisation_id', 'record_id');
    if existing_columns is distinct from expected_columns
      or exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname in ('organisation_id', 'record_id')
          and (attribute.atttypid <> 'uuid'::regtype
            or not attribute.attnotnull
            or attribute.atthasdef
            or exists (
              select 1 from pg_catalog.pg_attrdef as default_row
              where default_row.adrelid = attribute.attrelid
                and default_row.adnum = attribute.attnum
            )
            or attribute.attgenerated <> ''
            or attribute.attidentity <> ''
            or attribute.attnum < 1
            or attribute.attisdropped)
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname in ('organisation_id', 'record_id')
          and attribute.attnum > 0 and not attribute.attisdropped
      ) <> 2
      or exists (
        select 1
        from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_oid
          and constraint_row.contype <> 'p'
      )
      or not exists (
        select 1
        from pg_catalog.pg_constraint as constraint_row
        cross join lateral pg_catalog.unnest(constraint_row.conkey)
          with ordinality as key_column(attnum, ordinal_position)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = relation_oid and attribute.attnum = key_column.attnum
        where constraint_row.conrelid = relation_oid
          and constraint_row.contype = 'p'
        group by constraint_row.oid, constraint_row.convalidated
        having constraint_row.convalidated
          and not constraint_row.condeferrable
          and not constraint_row.condeferred
          and pg_catalog.array_agg(attribute.attname order by key_column.ordinal_position)
            = array['organisation_id', 'record_id']::name[]
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conrelid = relation_oid and constraint_row.contype = 'p'
      ) <> 1
      or exists (
        select 1 from pg_catalog.pg_index as index_row
        where index_row.indrelid = relation_oid and not index_row.indisprimary
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;

    if exists (
      select 1
      from vortex_record.field_storage_mappings as mapping
      left join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation_oid
        and attribute.attname = mapping.physical_column_token
        and attribute.attnum > 0 and not attribute.attisdropped
      left join pg_catalog.pg_attrdef as default_row
        on default_row.adrelid = attribute.attrelid
        and default_row.adnum = attribute.attnum
      where mapping.storage_contract_id = p_storage_contract_id
        and mapping.introduced_by_module_root_id <> p_target_module_root_id
        and (attribute.attnum is null
          or attribute.attnotnull
          or attribute.atthasdef
          or default_row.oid is not null
          or attribute.attgenerated <> ''
          or attribute.attidentity <> ''
          or attribute.atttypid is distinct from
            pg_catalog.to_regtype(vortex_record.sql_value_type(mapping.database_value_type))::oid)
    ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion relation is incompatible';
    end if;
    if not has_mapping then
      if exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid
          and attribute.attname = column_token
          and attribute.attnum > 0 and not attribute.attisdropped
      ) then
        raise exception using errcode = '55000',
          message = 'Existing contributed field storage is incompatible';
      end if;
      expected_columns := expected_columns || column_token;
    end if;

    select pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE')
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee = adapter_role_oid
          and (privilege.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')
            or privilege.is_grantable)
      ),
      pg_catalog.count(*) filter (
        where privilege.grantee not in (owner_role_oid, adapter_role_oid)
      )
    into acl_adapter_count, acl_adapter_invalid_count, acl_other_count
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) as privilege
    where relation.oid = relation_oid;
    if acl_adapter_count <> 3
      or acl_adapter_invalid_count <> 0
      or acl_other_count <> 0
      or exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_oid and attribute.attacl is not null
      ) then
      raise exception using errcode = '55000',
        message = 'Existing projection companion grants are incompatible';
    end if;

    select pg_catalog.regexp_replace(pg_catalog.lower(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
      ), '\s+', '', 'g')
    into policy_expression
    from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_oid
      and policy.polname = 'projection_companion_record_access';
    if policy_expression is distinct from '(organisation_id=vortex_platform.organization_id())'
      or not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
          and policy.polname = 'projection_companion_record_access'
          and policy.polpermissive
          and policy.polcmd = '*'
          and policy.polroles = array[adapter_role_oid]::oid[]
          and pg_catalog.regexp_replace(pg_catalog.lower(
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
          ), '\s+', '', 'g')
            = '(organisation_id=vortex_platform.organization_id())'
      )
      or (
        select pg_catalog.count(*) from pg_catalog.pg_policy as policy
        where policy.polrelid = relation_oid
      ) <> 1 then
      raise exception using errcode = '55000',
        message = 'Existing projection companion policies are incompatible';
    end if;

    if p_validate_only then
      return;
    end if;
    if not has_mapping then
      execute pg_catalog.format(
        'alter table record_data.%I add column %I %s', table_token, column_token, sql_type
      );
    end if;
  end if;

  relation_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token))::oid;
  select coalesce(
      pg_catalog.array_agg(expected_column.value order by expected_column.value),
      array[]::text[]
    )
  into expected_columns
  from pg_catalog.unnest(expected_columns) as expected_column(value);
  select coalesce(
      pg_catalog.array_agg(attribute.attname order by attribute.attname),
      array[]::text[]
    )
  into existing_columns
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = relation_oid
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attname not in ('organisation_id', 'record_id');
  if existing_columns is distinct from expected_columns
    or not exists (
      select 1 from pg_catalog.pg_attribute as attribute
      where attribute.attrelid = relation_oid
        and attribute.attname = column_token
        and attribute.attnum > 0 and not attribute.attisdropped
        and not attribute.attnotnull
        and not attribute.atthasdef
        and not exists (
          select 1 from pg_catalog.pg_attrdef as default_row
          where default_row.adrelid = attribute.attrelid
            and default_row.adnum = attribute.attnum
        )
        and attribute.attgenerated = ''
        and attribute.attidentity = ''
        and attribute.atttypid = pg_catalog.to_regtype(sql_type)::oid
    ) then
    raise exception using errcode = '55000',
      message = 'Existing projection companion relation is incompatible';
  end if;
end
$function$;

alter function vortex_record.create_system_projection_companion_storage_internal(uuid,uuid,uuid,uuid,jsonb,boolean) owner to vortex_owner;

alter function vortex_record.create_system_projection_companion_storage_internal(uuid,uuid,uuid,uuid,jsonb,boolean)
  owner to vortex_owner;

revoke all on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean)
  to vortex_owner;

comment on function vortex_record.create_system_projection_companion_storage_internal(uuid, uuid, uuid, uuid, jsonb, boolean) is
  'Privately preflights or provisions one optional unindexed companion field for an exact system-projection storage contract. Companion rows are organisation-scoped and are never written by a separate Record command.';

create or replace function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, 'transfer', p_record_id, p_expected_concurrency_number, p_installation,
    null::jsonb
  );
end
$function$;

alter function vortex_record.load_record_access_facts_for_transfer_installation_internal(uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) to vortex_record_adapter;

comment on function vortex_record.load_record_access_facts_for_transfer_installation_internal(
  uuid, uuid, bigint, jsonb
) is
  'Private complete record-scope fact loader for transfer, parameterised only by an exact trusted installation.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
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
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
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

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;

  select release.record_content
  into strict application_content
  from vortex_definition.runtime_releases as release
  where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
    and release.release_revision =
      (installation ->> 'applicationReleaseRevision')::bigint;

  unsupported := exists (
    select 1
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_system_projection_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;

comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.prepare_named_action_command_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_creations jsonb,
  p_activity_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  root_type jsonb;
  creation_count integer;
  before_closure jsonb;
  after_closure jsonb;
  link_targets jsonb;
  lock_plan jsonb;
  lock_entry jsonb;
  locked_value jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  creation jsonb;
  rule_module_root_id uuid;
  rule_release_revision bigint;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object'
    or pg_catalog.jsonb_typeof(coalesce(p_creations, '[]'::jsonb)) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  creation_count := pg_catalog.jsonb_array_length(coalesce(p_creations, '[]'::jsonb));
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;
  -- A set-only action still uses the terminal writer's total probe. A command
  -- with creations carries the exact release's rules for every closure record
  -- to the existing Record evaluator before any row is written.
  if creation_count = 0
    and coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  -- Authorize the subject without a row lock before discovering or locking any
  -- concrete dependency, through the installed named declaration. Executing a
  -- permitted action still requires no ordinary read or update authority.
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if access_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);

  before_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  link_targets := vortex_record.named_action_command_link_targets_internal(
    catalogue, p_record_type_id, p_submitted_values, p_creations
  );
  if before_closure is null or link_targets is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- One canonical row pass over the union of closure records (`for update`) and
  -- concrete link targets (`for share`). Taking both here, in one ascending
  -- concrete identity order, is what keeps a later `for share` inside the edge
  -- writer from queueing behind an exclusive waiter while this command already
  -- holds a resource that waiter needs.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storageContractId', grouped.storage_contract_id,
      'recordId', grouped.record_id,
      'recordTypeId', grouped.record_type_id,
      'mode', case when grouped.exclusive then 'update' else 'share' end
    ) order by grouped.storage_contract_id, grouped.record_id
  ), '[]'::jsonb)
  into lock_plan
  from (
    select entry.storage_contract_id, entry.record_id, entry.record_type_id,
      pg_catalog.bool_or(entry.exclusive) as exclusive
    from (
      select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
        (item.value ->> 'recordId')::uuid as record_id,
        (item.value ->> 'recordTypeId')::uuid as record_type_id,
        true as exclusive
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      union all
      select (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid,
        (item.value ->> 'recordTypeId')::uuid,
        false
      from pg_catalog.jsonb_array_elements(link_targets) item(value)
    ) entry
    group by entry.storage_contract_id, entry.record_id, entry.record_type_id
  ) grouped;

  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(lock_plan) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if lock_entry ->> 'mode' = 'update' then
      locked_value := vortex_record.relationship_total_record_snapshot_internal(
        catalogue, (lock_entry ->> 'recordTypeId')::uuid,
        (lock_entry ->> 'recordId')::uuid, true
      );
      if locked_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'restart');
      end if;
    elsif not vortex_record.share_lock_named_action_target_internal(
      catalogue, (lock_entry ->> 'recordTypeId')::uuid, (lock_entry ->> 'recordId')::uuid
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  -- A creation's link target is an ordinary record and keeps the ordinary read
  -- requirement. Deciding it here, under the lock and before any write, turns
  -- an unreadable target into a clean refusal instead of a late rollback. The
  -- command's own subject is excluded: the named authority decided above is
  -- sufficient for it, and requiring ordinary read would contradict #50.
  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if (lock_entry ->> 'recordTypeId')::uuid = p_record_type_id
      and (lock_entry ->> 'recordId')::uuid = p_record_id then
      continue;
    end if;
    target_loaded := vortex_record.load_record_access_facts_internal(
      (lock_entry ->> 'recordTypeId')::uuid, 'read',
      (lock_entry ->> 'recordId')::uuid, null, null::jsonb
    );
    if target_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_loaded -> 'declaration', (lock_entry ->> 'recordId')::uuid,
      target_loaded -> 'facts'
    );
    if target_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  after_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if access_loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);

  -- `not_required` is decided over the union of the subject type and every
  -- creation target type, and only after the locks above, so a command that
  -- needs no total still acquires its resources in the canonical order.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    join pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
      on true
    where field.value ->> 'type' = 'total'
  ) and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where pg_catalog.jsonb_array_length(
      coalesce(item.value -> 'recordType' -> 'relationships', '[]'::jsonb)
    ) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' and prepared_record ? 'recordId' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or not (prepared_record ? 'recordId')
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        rule_module_root_id,
        rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      source_records := '[]'::jsonb;
      if prepared_record ? 'recordId' then
        for edge_value in
          select edge.* from vortex_record.relationship_edges edge
          where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
            and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
            and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
            and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
            and edge.from_organisation_id = context_organization_id
            and edge.to_organisation_id = context_organization_id
            and edge.from_application_root_id is not distinct from case
              when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end
            and edge.to_application_root_id is not distinct from case
              when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
          order by edge.from_storage_contract_id, edge.from_record_id
        loop
          source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, false
          );
          if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
            return pg_catalog.jsonb_build_object('outcome', 'restart');
          end if;
          select item.value ->> 'recordKey' into source_key
          from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
          where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
            and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fieldValues', source_snapshot -> 'existingValues'
            ) || case when source_key is null then '{}'::jsonb
              else pg_catalog.jsonb_build_object('recordKey', source_key) end
          );
        end loop;
      end if;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then
          proposed_target := p_submitted_values -> source_field_id;
        end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;

      -- Each creation that links to this parent through this relationship joins
      -- its membership. A created record has no edges yet, so nothing is
      -- removed; the evaluator substitutes its computed values by record key.
      for creation in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
          with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') <>
          pg_catalog.lower((creation ->> 'recordTypeId')::uuid::text) then
          continue;
        end if;
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        proposed_target := creation -> 'values' -> source_field_id;
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and pg_catalog.lower(proposed_target ->> 'recordTypeId') =
            pg_catalog.lower(prepared_record ->> 'recordTypeId')
          and pg_catalog.lower(proposed_target ->> 'recordId') =
            pg_catalog.lower(prepared_record ->> 'recordId') then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordKey', 'create:' || (creation ->> 'ordinal'),
              'fieldValues', '{}'::jsonb
            )
          );
        end if;
      end loop;

      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) to vortex_runtime;

comment on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';

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

create or replace function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
  rule_module_root_id uuid;
  rule_release_revision bigint;
begin
  if p_operation not in ('create', 'update')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'update' and p_selected_group_id is not null)
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  -- Receipt resolution remains owned by prepare_base_record_save. Merely seeing
  -- an existing identity here avoids dependency reads or locks on replays and
  -- changed-input duplicates.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue -> 'applicationRuleSubjectRecordTypeIds', '[]'::jsonb)
    ) subject(record_type_id)
    where pg_catalog.lower(subject.record_type_id) = pg_catalog.lower(p_record_type_id::text)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(root_type -> 'fields') field(value)
    where field.value ->> 'type' = 'total'
  ) and pg_catalog.jsonb_array_length(root_type -> 'relationships') = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  -- Authorize the old source without a row lock before discovering or locking
  -- any concrete dependency. A denied update is deferred to the base prepare,
  -- which owns the existing content-free refusal Activity.
  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, null, null::jsonb
    );
    if access_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'defer');
    end if;
    if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', context_organization_id,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);
  end if;

  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if before_closure is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  -- Application-owned rules have no executable Module rule set. Defer to the
  -- base writer, which refuses a total change that cannot evaluate them.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') record(value)
    join pg_catalog.jsonb_array_elements_text(
      coalesce(catalogue -> 'applicationRuleSubjectRecordTypeIds', '[]'::jsonb)
    ) subject(record_type_id)
      on pg_catalog.lower(subject.record_type_id) =
        pg_catalog.lower(record.value ->> 'recordTypeId')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if after_closure is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- A concurrent exact or changed-input duplicate may have completed while
  -- this transaction waited for the source/parent locks. Let the existing
  -- receipt owner distinguish replay from command-identity conflict.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if p_operation = 'update' and (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if access_loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);
  end if;

  -- Materialize only the declared aggregate sources for each locked affected
  -- record. The initial source's proposed move replaces its old membership in
  -- this transaction-visible snapshot.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' then
      -- Use the established exact-record read path while the parent is locked.
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        rule_module_root_id, rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then proposed_target := p_submitted_values -> source_field_id; end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;

comment on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private Stage 2B preflight: discovers old/proposed concrete total closure, locks it canonically, re-reads it, and returns only declared evaluator inputs.';

create or replace function vortex_record.provision_exact_module_contributions(
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_contributions jsonb
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  contribution_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  contribution jsonb;
  contribution_id uuid;
  contribution_kind text;
  contributor_root_id uuid;
  target_module_root_id uuid;
  target_module_version text;
  target_extension_point_id uuid;
  target_record_type_id uuid;
  source_record_type_id uuid;
  field_id_value uuid;
  source_field jsonb;
  storage_id uuid;
  storage_ids uuid[] := array[]::uuid[];
  target_release vortex_definition.releases%rowtype;
  target_content jsonb;
  target_record_type jsonb;
  target_point jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  table_token text;
  column_token text;
  storage_scope_value text;
  scope_index_columns text;
  database_type text;
  sql_type text;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  view_oid oid;
  reader_function_oid oid;
  contribution_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_contributions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_contributions) < 1
    or pg_catalog.jsonb_array_length(p_contributions) > 100 then
    raise exception using errcode = '22023',
      message = 'Module contribution storage command is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if release_row.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact contributor Module release is incompatible';
  end if;

  -- Resolve every target record table first, then take its storage lineage lock
  -- in canonical storage-identity order, so a concurrent provisioner and this
  -- helper acquire the same locks in the same order.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if pg_catalog.jsonb_typeof(contribution) is distinct from 'object'
      or pg_catalog.jsonb_typeof(contribution -> 'contributorModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetRecordTypeId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end if;
    begin
      contributor_root_id := (contribution ->> 'contributorModuleRootId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(contributor_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_record_type_id::text)
      or contributor_root_id <> p_module_root_id
      or target_module_root_id = p_module_root_id then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;
    select catalogue.storage_contract_id into storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if storage_id is null then
      raise exception using errcode = '55000',
        message = 'Target record storage is unavailable';
    end if;
    storage_ids := storage_ids || storage_id;
  end loop;

  for storage_id in
    select distinct item.value
    from pg_catalog.unnest(storage_ids) as item(value)
    order by item.value
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
  end loop;

  -- Preflight every projection field in the complete contribution array before
  -- the first generated-table or companion-storage DDL. A later unsupported
  -- projection field therefore cannot follow an earlier physical change.
  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if contribution ->> 'kind' is distinct from 'field' then
      continue;
    end if;
    begin
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_extension_point_id := (contribution ->> 'targetExtensionPointId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
      source_record_type_id := (contribution ->> 'recordTypeId')::uuid;
      field_id_value := (contribution ->> 'fieldId')::uuid;
      contribution_id := (contribution ->> 'contributionId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    target_module_version := contribution ->> 'targetModuleReleaseVersion';
    if target_module_version is null
      or not vortex_platform.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_platform.is_non_nil_uuid(target_extension_point_id::text)
      or not vortex_platform.is_non_nil_uuid(target_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or not vortex_platform.is_non_nil_uuid(contribution_id::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;

    select release.* into strict target_release
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = target_module_root_id
      and release.release_version = target_module_version
      and root.kind = 'module';
    if target_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module')) then
      raise exception using errcode = '23514',
        message = 'Exact target Module release is incompatible';
    end if;
    target_content := target_release.compilation_output #> '{canonical,content}';
    select item.value into target_record_type
    from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId')
      = pg_catalog.lower(target_record_type_id::text);
    if target_record_type is null then
      raise exception using errcode = '23514', message = 'Target record type is unavailable';
    end if;
    is_projection := target_record_type ? 'systemProjection';
    if not is_projection then
      continue;
    end if;

    -- Projection fields are optional and unindexed by contract. Use JSONB
    -- identity comparisons so a missing or non-boolean flag cannot pass.
    select item.value into target_point
    from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as item(value)
    where pg_catalog.lower(item.value ->> 'extensionPointId')
      = pg_catalog.lower(target_extension_point_id::text);
    if target_point is null
      or pg_catalog.lower(target_point ->> 'recordTypeId')
        <> pg_catalog.lower(target_record_type_id::text)
      or not coalesce((target_point -> 'accepts') ? 'field', false) then
      raise exception using errcode = '23514', message = 'Target extension point is unavailable';
    end if;
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
          coalesce(release_row.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
        ) as item(value)
      where pg_catalog.lower(item.value ->> 'contributionId')
          = pg_catalog.lower(contribution ->> 'contributionId')
        and item.value ->> 'kind' = 'field'
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(target_module_root_id::text)
        and pg_catalog.lower(item.value ->> 'targetExtensionPointId')
          = pg_catalog.lower(target_extension_point_id::text)
        and pg_catalog.lower(item.value ->> 'recordTypeId')
          = pg_catalog.lower(source_record_type_id::text)
    ) then
      raise exception using errcode = '23514',
        message = 'Module contribution declaration is unavailable';
    end if;
    source_field := null;
    select item.value into source_field
    from pg_catalog.jsonb_array_elements(
        release_row.compilation_output #> '{canonical,content,recordTypes}'
      ) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as item(value)
    where pg_catalog.lower(record_item.value ->> 'recordTypeId')
        = pg_catalog.lower(source_record_type_id::text)
      and pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text);
    if source_field is null then
      raise exception using errcode = '23514',
        message = 'Contributed field definition is unavailable';
    end if;
    if source_field -> 'required' is distinct from 'false'::jsonb
      or source_field -> 'unique' is distinct from 'false'::jsonb
      or source_field -> 'filterable' is distinct from 'false'::jsonb
      or source_field -> 'sortable' is distinct from 'false'::jsonb then
      raise exception using errcode = '23514',
        message = 'A system projection contribution must be optional and unindexed';
    end if;
    database_type := vortex_record.database_value_type(source_field);
    sql_type := vortex_record.sql_value_type(database_type);
    if database_type is null or sql_type is null then
      raise exception using errcode = '23514',
        message = 'Contributed field type is unsupported';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as item(value)
      where pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text)
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_content -> 'actions') as item(value)
      where pg_catalog.lower(item.value ->> 'actionId')
        = pg_catalog.lower(field_id_value::text)
    ) then
      raise exception using errcode = '55000',
        message = 'Contributed field collides with target storage';
    end if;

    begin
      storage_id := (target_record_type ->> 'storageContractId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '55000',
        message = 'Target record storage lineage is incompatible';
    end;
    protected_view_key := target_record_type #>> '{systemProjection,protectedView}';
    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not (storage_id = any (storage_ids))
      or storage_id <> stored_catalogue.storage_contract_id
      or not exists (
        select 1
        from vortex_record.release_provisions as provision
        where provision.module_root_id = target_release.root_id
          and provision.release_revision = target_release.release_revision
          and storage_id = any (provision.storage_contract_ids)
      )
      or target_record_type ->> 'storageScope' is distinct from 'organization_shared'
      or stored_catalogue.storage_scope is distinct from 'organization_shared'
      or stored_catalogue.physical_schema_token is distinct from 'system_projection'
      or stored_catalogue.physical_table_token is distinct from
        ('rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', ''))
      or stored_catalogue.protected_read_model_key is distinct from protected_view_key
      or protected_view_key is null then
      raise exception using errcode = '55000',
        message = 'Target record storage lineage is incompatible';
    end if;
    select registered.reader_schema, registered.reader_function
    into reader_schema_value, reader_function_value
    from vortex_record.protected_read_model_views as registered
    where registered.protected_read_model_key = protected_view_key;
    if not found then
      raise exception using errcode = '55000',
        message = 'Protected projection view is unavailable';
    end if;
    view_oid := pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', 'record_data', stored_catalogue.physical_table_token
    ))::oid;
    reader_function_oid := pg_catalog.to_regprocedure(pg_catalog.format(
      '%I.%I(uuid[],text,text,jsonb,integer)', reader_schema_value, reader_function_value
    ))::oid;
    if view_oid is null
      or reader_function_oid is null
      or not exists (
        select 1
        from pg_catalog.pg_class as relation
        where relation.oid = view_oid
          and relation.relkind = 'v'
          and relation.relowner = 'vortex_owner'::regrole
      )
      or exists (
        select 1 from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid = view_oid and not trigger.tgisinternal
      )
      or exists (
        select 1 from pg_catalog.pg_rewrite as rule
        where rule.ev_class = view_oid and rule.rulename <> '_RETURN'
      )
      or not exists (
        select 1
        from pg_catalog.pg_rewrite as rule
        join pg_catalog.pg_depend as dependency
          on dependency.classid = 'pg_rewrite'::regclass
          and dependency.objid = rule.oid
          and dependency.refclassid = 'pg_proc'::regclass
          and dependency.refobjid = reader_function_oid
        where rule.ev_class = view_oid and rule.rulename = '_RETURN'
      )
      or not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = view_oid
          and attribute.attname = 'record_id'
          and attribute.attnum > 0 and not attribute.attisdropped
      )
      or not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = view_oid
          and attribute.attname = 'organisation_id'
          and attribute.attnum > 0 and not attribute.attisdropped
      )
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as field_item(value)
        where not exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = view_oid
            and attribute.attname = 'f_' || pg_catalog.replace(
              pg_catalog.lower(field_item.value ->> 'fieldId'), '-', ''
            )
            and attribute.attnum > 0 and not attribute.attisdropped
        )
      )
      or (
        select pg_catalog.count(*)
        from pg_catalog.pg_class as relation
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation.relacl, pg_catalog.acldefault('r', relation.relowner)
        )) as privilege
        where relation.oid = view_oid
          and privilege.grantee = 'vortex_record_adapter'::regrole::oid
          and privilege.privilege_type = 'SELECT'
          and not privilege.is_grantable
      ) <> 1
      or exists (
        select 1
        from pg_catalog.pg_class as relation
        cross join lateral pg_catalog.aclexplode(coalesce(
          relation.relacl, pg_catalog.acldefault('r', relation.relowner)
        )) as privilege
        where relation.oid = view_oid
          and (privilege.grantee not in (
              'vortex_owner'::regrole::oid,
              'vortex_record_adapter'::regrole::oid
            )
            or (privilege.grantee = 'vortex_record_adapter'::regrole::oid
              and privilege.privilege_type <> 'SELECT')
            or (privilege.grantee = 'vortex_record_adapter'::regrole::oid
              and privilege.is_grantable))
      )
      or exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = view_oid and attribute.attacl is not null
      ) then
      raise exception using errcode = '55000',
        message = 'Protected projection view lineage is incompatible';
    end if;

    perform vortex_record.create_system_projection_companion_storage_internal(
      storage_id, target_module_root_id, target_record_type_id,
      p_module_root_id, source_field, true
    );
  end loop;

  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    begin
      contribution_id := (contribution ->> 'contributionId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_extension_point_id := (contribution ->> 'targetExtensionPointId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    contribution_kind := contribution ->> 'kind';
    target_module_version := contribution ->> 'targetModuleReleaseVersion';
    if contribution_id is null
      or contribution_kind is null
      or target_module_version is null
      or not vortex_platform.is_non_nil_uuid(contribution_id::text)
      or not vortex_platform.is_non_nil_uuid(target_extension_point_id::text)
      or contribution_kind not in ('field', 'action') then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;

    -- The target is the exact dependency release the resolver bound; it must
    -- still declare the accepting extension point on the named record type.
    select release.* into strict target_release
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = target_module_root_id
      and release.release_version = target_module_version
      and root.kind = 'module';
    if target_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module')) then
      raise exception using errcode = '23514',
        message = 'Exact target Module release is incompatible';
    end if;
    target_content := target_release.compilation_output #> '{canonical,content}';
    select item.value into target_record_type
    from pg_catalog.jsonb_array_elements(target_content -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId')
      = pg_catalog.lower(target_record_type_id::text);
    if target_record_type is null then
      raise exception using errcode = '23514', message = 'Target record type is unavailable';
    end if;
    select item.value into target_point
    from pg_catalog.jsonb_array_elements(target_content -> 'extensionPoints') as item(value)
    where pg_catalog.lower(item.value ->> 'extensionPointId')
      = pg_catalog.lower(target_extension_point_id::text);
    if target_point is null
      or pg_catalog.lower(target_point ->> 'recordTypeId')
        <> pg_catalog.lower(target_record_type_id::text)
      or not coalesce((target_point -> 'accepts') ? contribution_kind, false) then
      raise exception using errcode = '23514',
        message = 'Target extension point is unavailable';
    end if;

    -- The contributor's own exact release must declare this contribution to this
    -- target Module's extension point; a caller cannot attach an undeclared field
    -- or action.
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
          coalesce(release_row.compilation_output #> '{canonical,content,contributions}', '[]'::jsonb)
        ) as item(value)
      where pg_catalog.lower(item.value ->> 'contributionId')
          = pg_catalog.lower(contribution_id::text)
        and item.value ->> 'kind' = contribution_kind
        and pg_catalog.lower(item.value #>> '{targetModule,moduleRootId}')
          = pg_catalog.lower(target_module_root_id::text)
        and pg_catalog.lower(item.value ->> 'targetExtensionPointId')
          = pg_catalog.lower(target_extension_point_id::text)
        and (contribution_kind <> 'field'
          or pg_catalog.lower(item.value ->> 'recordTypeId')
            = pg_catalog.lower(contribution ->> 'recordTypeId'))
    ) then
      raise exception using errcode = '23514',
        message = 'Module contribution declaration is unavailable';
    end if;

    if contribution_kind = 'action' then
      -- An action contribution has no physical storage; the exact resolved
      -- binding already carries the capability, so only its identity is echoed.
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements(release_row.compilation_output #> '{canonical,content,actions}') as item(value)
        where pg_catalog.lower(item.value ->> 'actionId') = pg_catalog.lower(contribution_id::text)
      ) then
        raise exception using errcode = '23514',
          message = 'Contributed action definition is unavailable';
      end if;
      contribution_ids := contribution_ids || contribution_id;
      continue;
    end if;

    -- A field contribution reuses the contributor's exact field definition and
    -- adds its permanent value storage to the target's generated table or projection companion.
    begin
      source_record_type_id := (contribution ->> 'recordTypeId')::uuid;
      field_id_value := (contribution ->> 'fieldId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    if not vortex_platform.is_non_nil_uuid(source_record_type_id::text)
      or not vortex_platform.is_non_nil_uuid(field_id_value::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;
    source_field := null;
    select item.value into source_field
    from pg_catalog.jsonb_array_elements(
        release_row.compilation_output #> '{canonical,content,recordTypes}'
      ) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as item(value)
    where pg_catalog.lower(record_item.value ->> 'recordTypeId')
        = pg_catalog.lower(source_record_type_id::text)
      and pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text);
    if source_field is null then
      raise exception using errcode = '23514',
        message = 'Contributed field definition is unavailable';
    end if;

    -- The contributed identity may not collide with the target's own component.
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_record_type -> 'fields') as item(value)
      where pg_catalog.lower(item.value ->> 'fieldId')
        = pg_catalog.lower(field_id_value::text)
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(target_content -> 'actions') as item(value)
      where pg_catalog.lower(item.value ->> 'actionId')
        = pg_catalog.lower(field_id_value::text)
    ) then
      raise exception using errcode = '55000',
        message = 'Contributed field collides with target storage';
    end if;

    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    table_token := stored_catalogue.physical_table_token;
    storage_scope_value := stored_catalogue.storage_scope;
    scope_index_columns := vortex_record.index_scope_columns(storage_scope_value);
    is_projection := target_record_type ? 'systemProjection';
    column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
    database_type := vortex_record.database_value_type(source_field);
    sql_type := vortex_record.sql_value_type(database_type);
    if database_type is null or sql_type is null then
      raise exception using errcode = '23514', message = 'Contributed field type is unsupported';
    end if;

    if is_projection then
      begin
        storage_id := (target_record_type ->> 'storageContractId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '55000',
          message = 'Target record storage lineage is incompatible';
      end;
      if storage_id is distinct from stored_catalogue.storage_contract_id
        or stored_catalogue.storage_scope is distinct from 'organization_shared'
        or stored_catalogue.physical_schema_token is distinct from 'system_projection'
        or stored_catalogue.physical_table_token is distinct from
          ('rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', ''))
        or stored_catalogue.protected_read_model_key is distinct from
          (target_record_type #>> '{systemProjection,protectedView}') then
        raise exception using errcode = '55000',
          message = 'Target record storage lineage is incompatible';
      end if;
      perform vortex_record.create_system_projection_companion_storage_internal(
        stored_catalogue.storage_contract_id, target_module_root_id,
        target_record_type_id, p_module_root_id, source_field, false
      );
      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = stored_catalogue.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.introduced_by_module_root_id <> p_module_root_id
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(source_field)
          or stored_field.state not in ('active', 'retired') then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        if stored_field.state = 'retired' then
          update vortex_record.field_storage_mappings as mapping
          set state = 'active',
              retired_by_module_root_id = null,
              retired_at_release_revision = null
          where mapping.storage_contract_id = stored_catalogue.storage_contract_id
            and mapping.field_id = field_id_value;
          any_change := true;
        end if;
      else
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          stored_catalogue.storage_contract_id, field_id_value, column_token, database_type,
          source_field, p_module_root_id, p_module_release_revision, 'active'
        );
        any_change := true;
      end if;
    else
      if stored_catalogue.physical_schema_token <> 'record_data'
        or scope_index_columns is null then
        raise exception using errcode = '55000', message = 'Target record storage is incompatible';
      end if;

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = stored_catalogue.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.introduced_by_module_root_id <> p_module_root_id
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(source_field)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        if stored_field.state = 'retired' then
          update vortex_record.field_storage_mappings as mapping
          set state = 'active',
              retired_by_module_root_id = null,
              retired_at_release_revision = null
          where mapping.storage_contract_id = stored_catalogue.storage_contract_id
            and mapping.field_id = field_id_value;
          any_change := true;
        elsif stored_field.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
      else
        if (source_field ->> 'required')::boolean then
          raise exception using errcode = '55000',
            message = 'A new contributed field must be optional on shared storage';
        end if;
        -- A column without a mapping has unknown meaning and values, so it is
        -- never adopted.
        if exists (
          select 1
          from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = pg_catalog.to_regclass(
              pg_catalog.format('%I.%I', 'record_data', table_token)
            )
            and attribute.attname = column_token
            and attribute.attnum > 0
            and not attribute.attisdropped
        ) then
          raise exception using errcode = '55000',
            message = 'Existing contributed field storage is incompatible';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s',
          table_token, column_token, sql_type
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          stored_catalogue.storage_contract_id, field_id_value, column_token, database_type,
          source_field, p_module_root_id, p_module_release_revision, 'active'
        );
        if (source_field ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            stored_catalogue.storage_contract_id, field_id_value, 'uniqueness',
            storage_scope_value, table_token, scope_index_columns, column_token
          );
        elsif (source_field ->> 'filterable')::boolean
          or (source_field ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            stored_catalogue.storage_contract_id, field_id_value, 'performance',
            storage_scope_value, table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end if;

    contribution_ids := contribution_ids || contribution_id;
  end loop;

  return query select p_module_root_id, p_module_release_revision, contribution_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module contribution evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module contribution evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_contributions(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb)
  to vortex_owner;

comment on function vortex_record.provision_exact_module_contributions(uuid, bigint, jsonb) is
  'Private exact-release contributor storage provisioner: adds generated-table fields or optional unindexed system-projection companion fields and records their retained lineage. It never drops a column, changes projection identity, or overwrites a value.';

create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  projection_expression_pair record;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  stored_projection_role text;
  requested_projection_role text;
  stored_database_type text;
  requested_database_type text;
  stored_sql_type text;
  requested_sql_type text;
  stored_expression jsonb;
  requested_expression jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  field_columns_sql text;
  projection_view_sql text;
  existing_columns text[];
  expected_columns text[];
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  -- A Module may hold no record types yet; its release is provisioned with no storage.
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision;
    if result_storage_ids is distinct from coalesce((
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ), array[]::uuid[]) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The eight-sortable-field limit is a publish rule; an older release may declare more and
    -- simply gets an index per sortable field.
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    -- A system projection record type has no generated storage. It is read
    -- through one registered protected view, created here as an ordinary
    -- record_data relation so the fixed read adapters resolve it unchanged,
    -- while the projection itself keeps every row-visibility rule inside the
    -- registered function. The view exposes exactly the record type's declared
    -- fields as record-data columns, plus the protected row identity and
    -- revision, and is read-only: the projection has no ordinary write path.
    -- Every projection value is reset per record type, so a generated record
    -- type provisioned after a projection never inherits its protected key.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    reader_schema_value := null;
    reader_function_value := null;
    projection_view_sql := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      select registered.reader_schema, registered.reader_function
      into reader_schema_value, reader_function_value
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501',
          message = 'Protected projection view is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
      field_columns_sql := '';
      expected_columns := array[]::text[];
      for field_value in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
        order by item.value ->> 'fieldId'
      loop
        begin
          field_id_value := (field_value ->> 'fieldId')::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '42501',
            message = 'Record field storage identity is invalid';
        end;
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        database_type := vortex_record.database_value_type(field_value);
        if database_type is null then
          raise exception using errcode = '23514',
            message = 'Record field storage type is unsupported';
        end if;
        sql_type := vortex_record.sql_value_type(database_type);
        expected_columns := expected_columns || column_token;
        if field_value ->> 'fieldId' = record_type #>> '{systemProjection,organizationFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.organization_id::text as %I, ', column_token);
        elsif field_value ->> 'fieldId' = record_type #>> '{systemProjection,revisionFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.revision::%s as %I, ', sql_type, column_token);
        elsif database_type = 'json' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values -> %L) as %I, ', field_value ->> 'key', column_token
            );
        else
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values ->> %L)::%s as %I, ',
              field_value ->> 'key', sql_type, column_token
            );
        end if;
      end loop;
      select pg_catalog.array_agg(item.column_name order by item.column_name)
      into expected_columns
      from pg_catalog.unnest(expected_columns) as item(column_name);
      field_columns_sql := pg_catalog.left(
        field_columns_sql, pg_catalog.length(field_columns_sql) - 2
      );
      projection_view_sql := pg_catalog.format(
        'create view record_data.%I as select
           projection.organization_id as organisation_id,
           %L::uuid as module_root_id,
           %L::uuid as record_type_id,
           %L::uuid as storage_contract_id,
           projection.record_id,
           null::uuid as application_root_id,
           %L::bigint as definition_revision,
           null::uuid as owner_organisation_account_id,
           null::uuid as owner_group_id,
           ''active''::text as lifecycle_state,
           projection.revision as concurrency_number,
           null::timestamptz as created_at,
           null::uuid as created_by,
           null::timestamptz as updated_at,
           null::uuid as updated_by,
           null::timestamptz as deleted_at,
           null::uuid as deleted_by,
           null::timestamptz as removal_due_at,
           %s
         from %I.%I(null::uuid[], ''record_id'', ''ascending'', null, null) as projection',
        table_token, p_module_root_id, record_type_id_value, storage_id,
        p_module_release_revision, field_columns_sql,
        reader_schema_value, reader_function_value
      );
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if is_projection then
        execute projection_view_sql;
        execute pg_catalog.format(
          'grant select on record_data.%I to vortex_record_adapter', table_token
        );
      else
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value
        );
      end if;

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, content_fingerprint, record_type_definition, protected_read_model_key
      ) values (
        storage_id,
        case when is_projection then 'system_projection' else 'record_data' end,
        table_token, p_module_root_id, record_type_id_value, storage_scope_value,
        p_module_release_revision, p_module_release_revision, 'active',
        shape_fingerprint, record_type, protected_view_key
      );
      any_change := true;
    else
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
        if pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition) is distinct from 'object'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'fields') is distinct from 'array'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'systemProjection') is distinct from 'object'
          or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object' then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;

        -- The catalogue keeps the newest compatible exact definition. Compare
        -- only shared field identities so an older subset and newer additions
        -- retain their existing release-order behavior. These descriptors
        -- mirror the source expressions assembled above, including the
        -- protected attribute key, JSON/text extraction, and cast.
        for projection_expression_pair in
          select requested_item.value as requested_field,
            stored_item.value as stored_field
          from pg_catalog.jsonb_array_elements(record_type -> 'fields') as requested_item(value)
          join pg_catalog.jsonb_array_elements(
            stored_catalogue.record_type_definition -> 'fields'
          ) as stored_item(value)
            on stored_item.value ->> 'fieldId' = requested_item.value ->> 'fieldId'
          order by requested_item.value ->> 'fieldId'
        loop
          stored_projection_role := case
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          requested_projection_role := case
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          stored_database_type := vortex_record.database_value_type(
            projection_expression_pair.stored_field
          );
          requested_database_type := vortex_record.database_value_type(
            projection_expression_pair.requested_field
          );
          if stored_projection_role is distinct from requested_projection_role
            or stored_database_type is null
            or requested_database_type is null then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
          stored_sql_type := vortex_record.sql_value_type(stored_database_type);
          requested_sql_type := vortex_record.sql_value_type(requested_database_type);
          stored_expression := case stored_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.revision',
              'cast', stored_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.stored_field ->> 'key',
              'extraction', case when stored_database_type = 'json' then '->' else '->>' end,
              'cast', case when stored_database_type = 'json' then null else stored_sql_type end
            )
          end;
          requested_expression := case requested_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.revision',
              'cast', requested_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.requested_field ->> 'key',
              'extraction', case when requested_database_type = 'json' then '->' else '->>' end,
              'cast', case when requested_database_type = 'json' then null else requested_sql_type end
            )
          end;
          if stored_expression is distinct from requested_expression then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
        end loop;

        select coalesce(
            pg_catalog.array_agg(attribute.attname order by attribute.attname),
            array[]::text[]
          )
        into existing_columns
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('%I.%I', 'record_data', table_token)
          )
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attname like 'f\_%';
        -- The view always carries the newest compatible release's shape, as a
        -- generated table keeps every column a newer release added. A newer
        -- release, or the newest one with a different field set, recreates it
        -- exactly; an older release, which the field checks below prove is a
        -- compatible subset, leaves the newer view alone. The projection has no
        -- indexes or dependent objects.
        if p_module_release_revision > stored_catalogue.last_compatible_release_revision
          or (p_module_release_revision = stored_catalogue.last_compatible_release_revision
            and existing_columns is distinct from expected_columns) then
          execute pg_catalog.format('drop view record_data.%I', table_token);
          execute projection_view_sql;
          execute pg_catalog.format(
            'grant select on record_data.%I to vortex_record_adapter', table_token
          );
          any_change := true;
        end if;
      else
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'record_data'
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if not is_projection then
          if stored_catalogue.storage_contract_id is not null
            and (field_value ->> 'required')::boolean then
            raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
          end if;
          execute pg_catalog.format(
            'alter table record_data.%I add column %I %s%s',
            table_token, column_token, sql_type,
            case when (field_value ->> 'required')::boolean then ' not null' else '' end
          );
        end if;
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        -- A projection field lives in the protected view, which carries no
        -- indexes; the projection's own protected function applies visibility,
        -- ordering and filtering, so no generated index is provisioned.
        if is_projection then
          null;
        elsif (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    -- Only a field this Module itself introduced can prove a removed field. A
    -- field another Module contributed keeps its retained lineage and never
    -- refuses this Module's own storage.
    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_by_module_root_id = p_module_root_id
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  -- The release declares each legacy Person field paired with its new link.
  -- Both field columns and relationship mappings now exist for every record type.
  perform vortex_record.backfill_person_links_internal(
    p_module_root_id, p_module_release_revision
  );

  select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[]) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_storage(uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_owner;

comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves the generated record_data storage, or the read-only record_data view over one registered protected projection reader for a system projection record type, for one published Module release and records its immutable provision evidence.';

CREATE FUNCTION vortex_record.read_derived_field_ids_for_exact_record_internal(p_record_type_id uuid, p_record_id uuid, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or pg_catalog.jsonb_typeof(p_required_field_ids) <> 'array'
    or pg_catalog.jsonb_typeof(p_seen_derived_field_keys) <> 'array' then
    return null;
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null, null::jsonb);
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return null;
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return null;
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  return vortex_record.project_derived_readable_field_ids_internal(
    loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds',
    p_required_field_ids, p_seen_derived_field_keys
  );
end
$$;

alter function vortex_record.read_derived_field_ids_for_exact_record_internal(uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

REVOKE ALL ON FUNCTION vortex_record.read_derived_field_ids_for_exact_record_internal(p_record_type_id uuid, p_record_id uuid, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) FROM PUBLIC;

CREATE FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  max_groups constant integer := 100;
  max_records constant integer := 1000;
  conflict_sql text;
  group_row record;
  record_id_value uuid;
  loaded jsonb;
  decision jsonb;
  readable_references jsonb := '[]'::jsonb;
  group_count integer := 0;
  record_count integer := 0;
begin
  if p_record_type_id is null
    or p_record_type_id = nil_uuid
    or p_table_token is null
    or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null
    or p_column_token !~ '^f_[a-f0-9]{32}$'
    or p_scope_columns is null
    or p_scope_columns not in ('organisation_id', 'organisation_id, application_root_id') then
    raise exception using errcode = '55000',
      message = 'Index conflict selector is invalid';
  end if;

  -- Only the participating record identities are selected; the conflicting
  -- field value is grouped on but never projected, so no raw value can leave.
  -- The search mirrors the unique index exactly: its lifecycle predicate, and
  -- no null value, because the index treats every null as distinct. The
  -- forced `record_data` policies keep it to the caller's organisation and
  -- Application.
  conflict_sql := pg_catalog.format(
    'select pg_catalog.array_agg(stored.record_id order by stored.record_id) as record_ids
     from record_data.%I as stored
     where stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
       and stored.%I is not null
     group by %s, stored.%I
     having pg_catalog.count(*) > 1
     order by 1
     limit %s',
    p_table_token, p_column_token, p_scope_columns, p_column_token, max_groups + 1
  );

  for group_row in execute conflict_sql
  loop
    group_count := group_count + 1;
    if group_count > max_groups then
      return pg_catalog.jsonb_build_object('outcome', 'unreadable');
    end if;

    for record_id_value in
      select id.value from pg_catalog.unnest(group_row.record_ids) as id(value)
    loop
      record_count := record_count + 1;
      if record_count > max_records then
        return pg_catalog.jsonb_build_object('outcome', 'unreadable');
      end if;

      begin
        loaded := vortex_record.load_record_access_facts_internal(
          p_record_type_id, 'read', record_id_value, null, null::jsonb
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object'
          or pg_catalog.jsonb_typeof(loaded -> 'facts') <> 'object' then
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
        end if;

        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', record_id_value, loaded -> 'facts'
        );
        -- Any unreadable participant collapses the whole conflict; a partial
        -- listing would be an existence oracle for the hidden rows.
        if decision ->> 'outcome' <> 'allowed' then
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
        end if;
      exception
        when others then
          -- Candidate-specific failures carry record detail; they collapse
          -- exactly like a refused decision.
          return pg_catalog.jsonb_build_object('outcome', 'unreadable');
      end;

      readable_references := readable_references || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', record_id_value
        )
      );
    end loop;
  end loop;

  if group_count = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'none');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'readable', 'records', readable_references);
end
$_$;

alter function vortex_record.read_index_conflict_references_internal(uuid,text,text,text) owner to vortex_record_adapter;

COMMENT ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) IS 'Adapter-owned resolution of one uniqueness index conflict: duplicate record identities only, each behind the exact read decision, collapsing wholly to one generic refusal when any participant is unreadable.';

REVOKE ALL ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) FROM PUBLIC;

REVOKE ALL ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) FROM vortex_record_adapter;

create or replace function vortex_record.read_record_capabilities(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  read_row record;
begin
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  if read_row.projection ->> 'outcome' <> 'allowed' then
    return null;
  end if;
  return vortex_record.read_record_capabilities_internal(
    p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds, null::jsonb
  );
end
$function$;

alter function vortex_record.read_record_capabilities(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_record.read_record_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_capabilities(uuid, uuid) is
  'Fixed record capabilities adapter: for one live record readable under the caller''s current authority or one owner-readable preview record, returns only permitted update, delete and restore actions and changeable fields; preview capabilities are limited to supported updates, and missing, foreign or unreadable records return null.';

create or replace function vortex_record.read_record_capabilities_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_read_facts jsonb,
  p_read_bounds jsonb,
  p_action_meta jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  readable_field_ids jsonb := p_read_bounds -> 'readableFieldIds';
  meta jsonb;
  changeable_field_ids jsonb := '[]'::jsonb;
  actions text[] := array[]::text[];
  action_kind text;
  action_loaded jsonb;
  action_decision jsonb;
  update_bounds jsonb;
  read_declaration jsonb;
  permission_by_id jsonb;
  target_meta jsonb;
  required_permissions jsonb;
  simple_action boolean;
begin
  -- The row is already known readable: the caller passes the read facts and
  -- field bounds its read decision used. Simple action routes can use these
  -- facts; actions with a wider closure still load their writer's own facts.
  if p_read_facts ? 'previewInstallationId' then
    select coalesce(
      pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
    )
    into changeable_field_ids
    from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        p_read_bounds -> 'changeableFieldIds'
      ) as changeable(value)
      where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
    );
    if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
      actions := array['update'];
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  if pg_catalog.jsonb_typeof(p_read_facts -> 'isSystemProjection') is distinct from 'boolean' then
    raise exception using errcode = '55000',
      message = 'Record capability metadata is unavailable';
  end if;
  -- Ordinary stored rows already passed the read loader's catalogue checks.
  -- Only a protected projection needs the extra action-context lookup.
  -- A page passes the context it resolved once for this record type.
  if (p_read_facts ->> 'isSystemProjection')::boolean then
    meta := coalesce(p_action_meta,
      vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read'));
  end if;
  if meta #>> '{recordType,key}' = 'organization_settings'
    and meta #>> '{recordType,systemProjection,protectedView}' =
      'organization_runtime_settings'
    and coalesce((meta #> '{recordType,standardActions}') ? 'update', false)
    and vortex_definition.is_system_projection_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    if vortex_access.organization_runtime_settings_manage_is_current() then
      select coalesce(
        pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
      )
      into changeable_field_ids
      from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
      join pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}') as field(value)
        on pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(projected.value)
      where field.value ->> 'key' not in ('organization_id', 'revision')
        and field.value ->> 'type' not in (
          'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
          'attachment', 'calculation'
        );
      if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
        actions := array['update'];
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  -- The read loader has already checked this installation's access plan and
  -- pinned record type; use those exact permissions for the action declarations.
  -- An action whose routes use only this target row can reuse the read facts.
  -- Relationship routes and inherited ownership still use the action's own
  -- fact closure, so no source row or edge needed by the writer is omitted.
  read_declaration := p_read_facts -> 'declaration';
  permission_by_id := p_read_facts -> 'accessPermissions';
  target_meta := p_read_facts -> 'recordTypeMeta';
  if pg_catalog.jsonb_typeof(read_declaration) is distinct from 'object'
    or pg_catalog.jsonb_typeof(permission_by_id) is distinct from 'object'
    or pg_catalog.jsonb_typeof(target_meta) is distinct from 'object'
    or (target_meta ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or coalesce(target_meta ->> 'ownershipMode', '') not in
      ('none', 'organization_account', 'group')
    or read_declaration -> 'recordBinding' is distinct from
      pg_catalog.jsonb_build_object(
        'moduleRootId', target_meta -> 'moduleRootId',
        'recordTypeId', target_meta -> 'recordTypeId',
        'storageContractId', target_meta -> 'storageContractId',
        'storageScope', target_meta -> 'storageScope'
      ) then
    permission_by_id := null;
  end if;

  -- Every action still receives its own declaration and exact-record decision.
  -- A missing declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := null;
    if permission_by_id is not null then
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'applicationRootId', (p_read_facts -> 'context' ->> 'applicationRootId')::uuid,
          'ownerKind', declared.value ->> 'ownerKind',
          'ownerId', (declared.value ->> 'ownerId')::uuid,
          'permissionId', declared.key::uuid
        )
        order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
      )
      into required_permissions
      from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
      where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
        and declared.value ->> 'actionKind' = action_kind
        and (declared.value ->> 'namedAction') is null
        and (
          declared.value ->> 'ownerKind' = 'application'
          or (declared.value ->> 'ownerId')::uuid = (target_meta ->> 'moduleRootId')::uuid
        );
      select not exists (
        select 1
        from pg_catalog.jsonb_array_elements(required_permissions) as required(value)
        join pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
          on declared.key = pg_catalog.lower(required.value ->> 'permissionId')
        where pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}')
            is distinct from 'array'
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(
              case when pg_catalog.jsonb_typeof(declared.value #> '{recordScope,routes}') = 'array'
                then declared.value #> '{recordScope,routes}'
                else '[]'::jsonb end
            ) as route(value)
            where coalesce(route.value ->> 'kind', '') not in
              ('all_records', 'ownership', 'direct_share')
          )
      ) into simple_action;
      if simple_action then
        action_loaded := pg_catalog.jsonb_build_object(
          'outcome', 'loaded',
          'declaration', read_declaration || pg_catalog.jsonb_build_object(
            'operationKey', 'record.' || action_kind,
            'action', pg_catalog.jsonb_build_object('actionKind', action_kind),
            'requiredPermissions', coalesce(required_permissions, '[]'::jsonb)
          ),
          'facts', p_read_facts -> 'facts'
        );
        if required_permissions is null then
          action_loaded := pg_catalog.jsonb_set(action_loaded, '{declaration}', 'null'::jsonb);
        end if;
      end if;
    end if;
    if action_loaded is null then
      action_loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, action_kind, p_record_id, null, null::jsonb
      );
    end if;
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      -- An action decided over the read facts reuses their record types, which
      -- the read decision validated in this invocation; an action that loaded
      -- its writer's own facts validates them in full.
      action_decision := vortex_access.evaluate_record_access_with_validated_types_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts', null,
        case when action_loaded -> 'facts' is not distinct from p_read_facts -> 'facts'
          then p_read_facts -> 'facts' -> 'recordTypes' end
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        -- The changeable fields are the update decision's own field bounds, the
        -- set the record save enforces, narrowed to the fields read_record
        -- projects for this row, so no hidden field is ever reported.
        if action_kind = 'update' then
          update_bounds := vortex_access.resolve_record_field_bounds_internal(action_decision);
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                update_bounds -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field it may change, so update is never
  -- reported without one.
  if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

alter function vortex_record.read_record_capabilities_internal(uuid,uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb, jsonb) is
  'Private record capabilities: returns the permitted update, delete and restore actions and changeable fields of one readable record, reusing the read facts and field bounds of its read decision, and the protected projection action context its caller resolved once in this invocation for the same record type when there is one.';

create or replace function vortex_record.read_record_projection_with_eligibility_internal(
  p_record_type_id uuid, p_record_id uuid, p_page_declaration jsonb, p_page_eligibility jsonb
) returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language sql volatile security invoker set search_path = '' as $function$
  select * from vortex_record.read_record_projection_with_validated_types_internal(
    p_record_type_id, p_record_id, p_page_declaration, p_page_eligibility, null::jsonb,
    null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb
  )
$function$;

alter function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb) owner to vortex_owner;

revoke all on function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb)
  to vortex_record_adapter;

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
        p_record_type_id, 'read', requested_id, null, null::jsonb
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
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds, null::jsonb
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

create or replace function vortex_record.read_record_with_capabilities(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  read_row record;
begin
  -- One exact read decision for one record serves both answers: the
  -- projection vortex_record.read_record returns and the capabilities
  -- vortex_record.read_record_capabilities returns, which reuse the read facts
  -- and field bounds of that decision exactly as read_record_capabilities does.
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  return pg_catalog.jsonb_build_object(
    'record', read_row.projection,
    'capabilities', case when read_row.projection ->> 'outcome' = 'allowed'
      then vortex_record.read_record_capabilities_internal(
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds, null::jsonb
      ) end
  );
end
$function$;

alter function vortex_record.read_record_with_capabilities(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_with_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_record.read_record_with_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_with_capabilities(uuid, uuid) is
  'Fixed record read adapter for one record: returns, from one read decision under the caller''s current authority, the readable field projection vortex_record.read_record returns (record) and the permitted actions and changeable fields vortex_record.read_record_capabilities returns (capabilities, null unless the record is readable).';

create or replace function vortex_record.read_system_projection_rows_internal(
  p_storage_contract_id uuid,
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  reader_schema text;
  reader_function text;
begin
  select registered.reader_schema, registered.reader_function
  into reader_schema, reader_function
  from vortex_record.storage_catalogue as storage
  join vortex_record.protected_read_model_views as registered
    on registered.protected_read_model_key = storage.protected_read_model_key
  where storage.storage_contract_id = p_storage_contract_id
    and storage.physical_schema_token = 'system_projection'
    and storage.state = 'active';
  if not found then
    raise exception using errcode = '55000',
      message = 'Protected projection reader is unavailable';
  end if;

  -- Every registered protected projection reader has the one bounded signature.
  return query execute pg_catalog.format(
    'select projected.* from %I.%I($1, $2, $3, $4, $5) as projected',
    reader_schema, reader_function
  ) using p_record_ids, p_sort_key, p_direction, p_after, p_limit;
end
$function$;

alter function vortex_record.read_system_projection_rows_internal(
  uuid, uuid[], text, text, jsonb, integer
) owner to vortex_owner;

revoke all on function vortex_record.read_system_projection_rows_internal(
  uuid, uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.read_system_projection_rows_internal(
  uuid, uuid[], text, text, jsonb, integer
) to vortex_record_adapter;

CREATE FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
begin
  begin
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'delete', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      return null;
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' is distinct from 'allowed' then
      return null;
    end if;
    return (loaded ->> 'concurrencyNumber')::bigint;
  exception
    when others then
      return null;
  end;
end
$$;

alter function vortex_record.record_lifecycle_current_revision_internal(uuid,uuid) owner to vortex_record_adapter;

REVOKE ALL ON FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) FROM PUBLIC;

create or replace function vortex_record.restore_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
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
  loaded jsonb;
  facts jsonb;
  record_fact jsonb;
  decision jsonb;
  field_item jsonb;
  relationship_value jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  target_catalogue vortex_record.storage_catalogue%rowtype;
  retained_value jsonb;
  retained_target_type_id uuid;
  retained_target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  field_required boolean;
  application_root_required boolean;
  changed_rows integer;
  app_scope uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  preview_installation jsonb;
  notice_sequence bigint;
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'restore');
    context_value := meta -> 'context';
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'restore', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    if record_fact ->> 'lifecycleState' <> 'soft_deleted' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- Restore access is decided over the retained row projected as the active
    -- candidate it would become.  The retained values/owner are unchanged.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding',
      'records', (
        select pg_catalog.jsonb_agg(
          case when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
            then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
            else item.value end order by item.ordinality
        )
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = 'P0002', message = 'Record is unavailable';
    end if;

    -- A restore keeps the retained values. Validate the narrow invariants this
    -- primitive owns: every currently required non-link value is present,
    -- non-null and has its canonical storage shape; every required link agrees
    -- with exactly one retained edge to a locked, active, currently readable
    -- target. Full final-value settings validation remains owned by #47.
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
      where coalesce((item.value ->> 'required')::boolean, false)
        or (item.value ->> 'type' in ('link', 'link_to_one_of_several')
          and coalesce((item.value #>> '{settings,applicationRootIdRequired}')::boolean, false))
    loop
      field_required := coalesce((field_item ->> 'required')::boolean, false);
      application_root_required := coalesce(
        (field_item #>> '{settings,applicationRootIdRequired}')::boolean, false
      );
      retained_value := record_fact -> 'fieldValues'
        -> pg_catalog.lower(field_item ->> 'fieldId');
      if not ((record_fact -> 'fieldValues') ? pg_catalog.lower(field_item ->> 'fieldId'))
        or pg_catalog.jsonb_typeof(retained_value) = 'null' then
        if field_required then
          raise exception using errcode = '23514', message = 'Required retained value is unavailable';
        end if;
        continue;
      end if;

      if field_item ->> 'type' not in ('link', 'link_to_one_of_several') then
        if not vortex_record.canonical_record_value_matches(
          retained_value,
          field_item ->> 'type',
          meta -> 'columns' -> pg_catalog.lower(field_item ->> 'fieldId')
            ->> 'databaseValueType'
        ) then
          raise exception using errcode = '23514', message = 'Required retained value is invalid';
        end if;
        continue;
      end if;

      select item.value into strict relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromFieldId')::uuid = (field_item ->> 'fieldId')::uuid;

      -- The retained value names its concrete target type; it must be one of
      -- the relationship's declared targets and the retained edge's target.
      if pg_catalog.jsonb_typeof(retained_value) <> 'object'
        or not (retained_value ?& array['recordTypeId', 'recordId'])
        or retained_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      begin
        retained_target_type_id := (retained_value ->> 'recordTypeId')::uuid;
        retained_target_record_id := (retained_value ->> 'recordId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end;
      if retained_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      if not vortex_record.relationship_declares_target_internal(
        relationship_value, retained_target_type_id
      ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      select edge.* into strict edge_row
      from vortex_record.relationship_edges as edge
      where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
        and edge.from_organisation_id = (context_value ->> 'organizationId')::uuid
        and edge.from_storage_contract_id = (meta ->> 'storageContractId')::uuid
        and edge.from_record_id = p_record_id;
      if edge_row.to_organisation_id <> (context_value ->> 'organizationId')::uuid
        or edge_row.to_record_id <> retained_target_record_id then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select catalogue.* into strict target_catalogue
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = edge_row.to_storage_contract_id
        and catalogue.record_type_id = retained_target_type_id
        and catalogue.physical_schema_token in ('record_data', 'system_projection')
        and catalogue.state = 'active';
      if application_root_required
        and (target_catalogue.physical_schema_token is distinct from 'system_projection'
          or target_catalogue.protected_read_model_key is distinct from 'organization_accounts') then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;

      perform vortex_record.lock_relationship_target_row_internal(
        retained_target_type_id, retained_target_record_id,
        (context_value ->> 'organizationId')::uuid
      );

      target_loaded := vortex_record.load_record_access_facts_internal(
        retained_target_type_id, 'read', retained_target_record_id, null, null::jsonb
      );
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      target_decision := vortex_access.evaluate_organization_record_access_internal(
        target_loaded -> 'declaration', retained_target_record_id, target_loaded -> 'facts'
      );
      if target_decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      select item.value into target_record
      from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
      where (item.value -> 'recordScope' ->> 'recordId')::uuid = retained_target_record_id;
      target_scope := target_record -> 'recordScope';
      if target_record is null or target_record ->> 'lifecycleState' <> 'active'
        or (target_scope ->> 'organizationId')::uuid <>
          (context_value ->> 'organizationId')::uuid
        or edge_row.to_application_root_id is distinct from (
          case when target_scope ->> 'storageScope' = 'application_contained'
            then (target_scope ->> 'applicationRootId')::uuid else null end
        ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
      if application_root_required
        and not vortex_access.organization_account_has_current_application_access_internal(
          (context_value ->> 'organizationId')::uuid,
          retained_target_record_id,
          (context_value ->> 'applicationRootId')::uuid
        ) then
        raise exception using errcode = '23514', message = 'Required relationship is unavailable';
      end if;
    end loop;

    execute pg_catalog.format(
      'update record_data.%I as stored
       set lifecycle_state = ''active'', concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
         deleted_at = null, deleted_by = null, removal_due_at = null,
         definition_revision = $4
       where organisation_id = $1 and record_id = $2
         and lifecycle_state = ''soft_deleted'' and concurrency_number = $5
       returning stored.record_id, stored.concurrency_number',
      meta ->> 'table'
    ) into saved_record_id, saved_concurrency_number
      using (context_value ->> 'organizationId')::uuid, p_record_id,
      (context_value ->> 'organizationAccountId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record restore revision changed';
    end if;
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    if preview_installation is null
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          (context_value ->> 'organizationId')::uuid,
          (context_value ->> 'applicationRootId')::uuid,
          p_record_type_id,
          saved_record_id,
          saved_concurrency_number,
          'changed',
          notice_sequence,
          notice_sequence,
          (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Allocation and publication are advisory; the guarded write is not.
        null;
      end;
    else
      perform vortex_record.bump_record_data_version_internal(
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'storageContractId')::uuid, app_scope
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', saved_record_id,
      'concurrencyNumber', saved_concurrency_number
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or too_many_rows or insufficient_privilege or check_violation
      or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end;
end
$function$;

alter function vortex_record.restore_record_internal(uuid,uuid,bigint) owner to vortex_record_adapter;

alter function vortex_record.restore_record_internal(uuid, uuid, bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.restore_record_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.restore_record_internal(uuid, uuid, bigint) is
  'Private revision-checked restore primitive over retained facts, current Access, current definition, required relationships and every non-null Person link with required application access; it locks record or protected projection targets through the canonical relationship lock and enforces no recovery window.';

create or replace function vortex_record.soft_delete_record_recursive_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  changed_rows integer;
  application_scope uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  preview_installation jsonb;
  notice_sequence bigint;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number, null::jsonb
  );
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by #401's fixed loader.
  for incoming in
    select edge.*, mapping.on_parent_delete, mapping.relationship_id,
      mapping.source_field_id
    from vortex_record.relationship_edges as edge
    join vortex_record.relationship_storage_mappings as mapping
      on mapping.relationship_id = edge.relationship_id
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when incoming.on_parent_delete = 'empty_optional' then 'update'
      when incoming.on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = incoming.source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if not found then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency, null::jsonb
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if incoming.on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if incoming.on_parent_delete = 'empty_optional' then
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
      );
      perform vortex_record.append_record_lifecycle_effect_internal(
        'optional_cleared', incoming.from_storage_contract_id,
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, incoming.relationship_id
      );
    elsif incoming.on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  execute pg_catalog.format(
    'update record_data.%I as stored
     set lifecycle_state = ''soft_deleted'',
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       deleted_at = pg_catalog.statement_timestamp(), deleted_by = $3,
       removal_due_at = null, definition_revision = $4
     where organisation_id = $1 and record_id = $2
       and lifecycle_state = ''active'' and concurrency_number = $5
     returning stored.record_id, stored.concurrency_number',
    meta ->> 'table'
  ) into saved_record_id, saved_concurrency_number using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record delete revision changed';
  end if;
  if saved_record_id is distinct from p_record_id
    or saved_concurrency_number is null
    or saved_concurrency_number not between 1 and 9007199254740991 then
    raise exception using errcode = '55000', message = 'Record delete saved identity is unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_effect_internal(
    'soft_deleted', (meta ->> 'storageContractId')::uuid,
    p_record_type_id, p_record_id, p_expected_concurrency_number, null
  );
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and meta ->> 'storageScope' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        application_scope, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'deleted',
        notice_sequence, notice_sequence,
        (context_value ->> 'correlationId')::uuid
      );
    exception when others then
      -- Invalidation is advisory; the protected delete remains transactional.
      null;
    end;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, application_scope
    );
  end if;
end
$function$;

alter function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]) is null;

create or replace function vortex_record.write_named_action_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid
)
returns void
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
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_subject_record_type_id is null or p_subject_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
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

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token'
    );
    execute update_sql using (source_context ->> 'organizationId')::uuid, p_source_record_id;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Relationship source record changed';
    end if;
    return;
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

  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  -- The one substitution. Executing a permitted named action must not require
  -- ordinary read authority on its own subject (#50 section 4), so when the
  -- selected target is exactly this command's subject the decision is taken on
  -- the installed named declaration instead. The loader re-resolves the active
  -- installation, the owner kind/id/release revision, the action id and the
  -- action's declared subject record type, and the Access evaluation binds the
  -- organization, application, record type, record and the actor's current
  -- authority. Every other target keeps the ordinary read check unchanged.
  if target_type_id = p_subject_record_type_id and target_record_id = p_subject_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := vortex_record.load_record_access_facts_internal(
      target_type_id, 'read', target_record_id, null, null::jsonb
    );
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
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

  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token'
  );
  execute update_sql using (source_context ->> 'organizationId')::uuid,
    p_source_record_id, p_target_value;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) to vortex_record_adapter;

comment on function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge writer: checks current application access for flagged Person links, uses the ordinary or protected projection target lock and edge flow, and authorises the command subject by re-evaluating the exact installed named action rather than ordinary read.';

create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
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
  existing_other boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_increment_source_revision is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
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

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_increment_source_revision then
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
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null%s
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token',
      case when p_increment_source_revision then
        ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $3'
      else '' end
    );
    if p_increment_source_revision then
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id, (source_context ->> 'organizationAccountId')::uuid;
    else
      execute update_sql using (source_context ->> 'organizationId')::uuid,
        p_source_record_id;
    end if;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    return;
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

  target_loaded := vortex_record.load_record_access_facts_internal(
    target_type_id, 'read', target_record_id, null, null::jsonb
  );
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
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
  if p_increment_source_revision then
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
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  );
  if p_increment_source_revision then
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value,
      (source_context ->> 'organizationAccountId')::uuid;
  else
    execute update_sql using (source_context ->> 'organizationId')::uuid,
      p_source_record_id, p_target_value;
  end if;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: validates the declared relationship and target eligibility, checks current application access for flagged Person links, share-locks the record or protected projection target, then takes the source data version and the shared edge identities before replacing the source link edge and typed value atomically. Owner-only.';

drop function vortex_access.evaluate_organization_record_access_page_internal(jsonb, jsonb);
drop function vortex_access.list_application_role_templates_projection(uuid, integer);
drop function vortex_access.list_installed_applications_projection(uuid, integer);
drop function vortex_access.list_organization_accounts_projection(uuid, integer, uuid[]);
drop function vortex_access.list_organization_accounts_projection(uuid, integer);
drop function vortex_access.list_organization_activity_entries_projection(uuid, integer);
drop function vortex_access.list_organization_delegations_projection(uuid, integer);
drop function vortex_access.list_organization_groups_projection(uuid, integer);
drop function vortex_access.list_organization_group_memberships_projection(uuid, integer);
drop function vortex_access.list_organization_invitations_projection(uuid, integer);
drop function vortex_access.list_organization_permissions_projection(uuid, integer);
drop function vortex_access.list_organization_roles_projection(uuid, integer);
drop function vortex_access.list_organization_role_activations_projection(uuid, integer);
drop function vortex_access.list_organization_role_assignments_projection(uuid, integer);
drop function vortex_access.list_organization_runtime_settings_projection(uuid, integer);
drop function vortex_identity.list_organizations_projection(uuid, integer);
drop function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean, uuid[]);
drop function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean);
drop function vortex_identity.list_organization_invitations_projection_internal(uuid);
drop function vortex_identity.list_tenants_projection(uuid, integer);
drop function vortex_identity.list_tenant_administrators_projection(uuid, integer);
drop function vortex_record.load_record_access_facts_from_installation_internal(uuid, text, uuid, bigint, jsonb);
drop function vortex_record.load_record_access_facts_internal(uuid, text, uuid, bigint);
drop function vortex_record.read_record_capabilities_internal(uuid, uuid, jsonb, jsonb);
drop function vortex_record.read_record_capabilities_page_internal(uuid, jsonb);
drop function vortex_record.read_record_page_decisions_internal(uuid, jsonb, jsonb, jsonb, uuid[]);
drop function vortex_record.read_record_projection_with_validated_types_internal(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb);
drop function vortex_record.read_record_projection_with_validated_types_internal(uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb);
drop function vortex_record.read_record_projection_with_validated_types_internal(uuid, uuid, jsonb, jsonb, jsonb, jsonb);
drop function vortex_record.read_record_projection_with_validated_types_internal(uuid, uuid, jsonb, jsonb, jsonb);

reset role;
