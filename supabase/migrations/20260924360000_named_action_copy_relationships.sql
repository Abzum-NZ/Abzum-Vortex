-- #570: a named action may copy explicitly selected relationships of its
-- subject to another record of the same type.
--
-- `copy_relationships` is a declared, published effect, but nothing executed
-- it: the preparation and the terminal writer both refused any effect kind
-- other than `set_field`, `create_record` and `announce_event`. This migration
-- executes it, and nothing else about the effect model changes.
--
-- The effect names its relationships and one `record_reference` input; it never
-- means "all relationships" (data-contracts, action effects). The published
-- definition already requires that input to accept the subject's own record
-- type, because the copied relationships are the subject's own links and only
-- a record of that type can hold them. For every selected relationship the
-- database re-derives, from the installed action and the supplied inputs and
-- never from anything the runtime asserts:
--
-- * the target: the input's record link, of the subject's record type and not
--   the subject itself;
-- * the relationships: each must be declared by the subject's record type as a
--   `many_to_one` link (a `one_to_one` link cannot be held by a second record)
--   whose link field the actor can currently read under the named action, and
--   no earlier `set_field` effect of the same action may change that link, so
--   the copied edge is the one the authored effect order implies;
-- * the edge: the subject's current edge for that relationship, whose concrete
--   target type must be a member of the relationship's declared targets
--   (`relationship_declares_target_internal`, #562);
-- * an unset subject relationship copies nothing, a target already holding the
--   same edge is left as is, and a target holding a different edge refuses the
--   whole command instead of re-pointing it. No existing edge is ever deleted
--   or re-pointed, and unselected or undeclared relationships are untouched;
-- * a relationship that feeds a relationship total refuses: the copy would move
--   a parent's total outside the merged totals closure this command prepared,
--   and that closure has no second root for the target. Refusing keeps every
--   stored total exact.
--
-- A refusal decided before anything is written is returned as a `refused`
-- outcome, which the runtime reports as a safe refusal rather than a
-- retryable failure.
--
-- Lock order follows #561 and #858: every target row is locked first
-- (exclusively, as it is about to change), then every linked row's share lock
-- in one canonical order, and only then the counters, data versions and
-- relationship edge identities that the reservation, the subject writer and the
-- edge writers take. The whole plan is taken before the reservation `#569`
-- added, so the lock classes never invert.
--
-- The copies are written by `change_record_relationship_internal`, the ordinary
-- relationship writer, in ascending relationship edge identity order: it
-- re-decides update authority over the target and its changeable field bound,
-- re-checks the linked record's read access, keeps the edge, the stored link
-- value, the target's revision and its data version consistent, and refuses a
-- relationship the target's type does not declare. By then the receipt and the
-- subject are written, so a refusal raises (`42501`, as a created record's
-- authorization does) and the receipt, the subject write, the creations and
-- the copies commit or roll back together. Each changed target then gets its
-- own Activity entry and `changed` Event.
--
-- The three existing functions are patched in place from their current live
-- definitions, as `20260924310000` does: each reviewed fragment must occur
-- exactly once, or the migration aborts instead of silently skipping a caller.
-- Grants, ownership and authorization are otherwise unchanged.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- ---------------------------------------------------------------------------
-- Plan and lock. Validates every `copy_relationships` effect against the
-- installed action and the supplied inputs, takes every target row lock and
-- then every linked row's share lock, and returns the edges to copy. Returns
-- null when the action has no such effect and a `refused` outcome for any
-- request it cannot honour; only a broken invariant raises.
-- ---------------------------------------------------------------------------
create function vortex_record.prepare_named_action_relationship_copies_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid,
  p_inputs jsonb
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
  effect_value jsonb;
  effect_ordinal bigint;
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
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_subject_record_type_id
  );
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'copy_relationships'
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
  for effect_value, effect_ordinal in
    select item.value, item.ordinality
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects')
      with ordinality as item(value, ordinality)
    where item.value ->> 'kind' = 'copy_relationships'
    order by item.ordinality
  loop
    -- The target is the declared `record_reference` input's record link, the
    -- one value shape that input accepts.
    input_candidate := p_inputs -> (effect_value ->> 'targetInputKey');
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
      where item.value ->> 'key' = effect_value ->> 'targetInputKey'
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
      from pg_catalog.jsonb_array_elements(effect_value -> 'relationshipIds') item(value)
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
        -- earlier effect sets that same link.
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects')
            with ordinality as earlier(value, ordinality)
          where earlier.ordinality < effect_ordinal
            and earlier.value ->> 'kind' = 'set_field'
            and pg_catalog.lower(earlier.value ->> 'fieldId') =
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

      -- Two effects may name the same target and relationship; it is copied once.
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

-- ---------------------------------------------------------------------------
-- Apply. Writes every planned copy through the ordinary relationship writer
-- against its target's current revision, in ascending relationship edge
-- identity order, then records each changed target's Activity and `changed`
-- Event. Every refusal raises, rolling the whole command back.
-- ---------------------------------------------------------------------------
create function vortex_record.apply_named_action_relationship_copies_internal(
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
    if pg_catalog.jsonb_array_length(event_result) <> 1 then
      raise exception using errcode = '55000',
        message = 'Relationship copy Event append failed';
    end if;
  end loop;
end
$function$;

-- Migration-time patch guard: returns the current definition with every
-- `[old, new]` pair substituted, each old fragment occurring exactly once.
create function vortex_record.apply_named_action_copy_patch_internal(
  p_procedure pg_catalog.regprocedure,
  p_patches jsonb
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  definition text;
  patch jsonb;
  old_text text;
  occurrences integer;
begin
  definition := pg_catalog.pg_get_functiondef(p_procedure);
  if definition is not null then
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
  end if;
  if definition is null or pg_catalog.jsonb_typeof(p_patches) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_patches) = 0 then
    raise exception using errcode = '22023',
      message = 'Named action copy patch is invalid';
  end if;
  for patch in select item.value from pg_catalog.jsonb_array_elements(p_patches) as item(value)
  loop
    old_text := patch ->> 0;
    if old_text is null or old_text = '' or patch ->> 1 is null then
      raise exception using errcode = '22023',
        message = 'Named action copy patch is invalid';
    end if;
    occurrences := (
      pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
    ) / pg_catalog.length(old_text);
    if occurrences <> 1 then
      raise exception using errcode = '55000',
        message = 'Named action copy patch does not match exactly once',
        detail = p_procedure::text;
    end if;
    definition := pg_catalog.replace(definition, old_text, patch ->> 1);
  end loop;
  return definition;
end
$function$;

do $migration$
declare
  -- The two preparation and writer guards that refused every other effect kind.
  prepare_kind_old constant text :=
    $q$item.value ->> 'kind' not in ('set_field', 'create_record', 'announce_event')$q$;
  prepare_kind_new constant text :=
    $q$item.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'announce_event')$q$;
  save_kind_old constant text :=
    $q$effect.value ->> 'kind' not in ('set_field', 'create_record', 'announce_event')$q$;
  save_kind_new constant text :=
    $q$effect.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'announce_event')$q$;

  -- The terminal writer's variable for the plan.
  declare_old constant text := $q$  event_result jsonb;$q$;
  declare_new constant text := $q$  event_result jsonb;
  copy_plan jsonb;$q$;

  -- After the merged preparation has locked the subject and every closure row,
  -- and ahead of the counters and data versions #569 reserves and every edge
  -- identity: the target row and every linked row, in #858's order. Only the
  -- fresh path plans a copy: a replay finds its claimed receipt and copies
  -- nothing again. A refused plan returns before anything is written, like the
  -- total refusals above.
  plan_old constant text :=
    $q$  -- #569: take every created record's reference-number counter (L4), then the$q$;
  plan_new constant text := $q$  -- #570: copy_relationships. The target row and every linked row are locked
  -- here, before the counters and data versions below and before any edge
  -- identity, so the lock classes keep their order. A replay copies nothing.
  if not exists (
    select 1 from vortex_record.named_action_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
    copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id, p_inputs
    );
    if copy_plan ->> 'outcome' = 'refused' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
      );
    end if;
  end if;
  -- #569: take every created record's reference-number counter (L4), then the$q$;

  -- The copies are written last, after the subject, every creation and its
  -- edges, so relationship edge identities stay the last lock class.
  apply_old constant text := $q$  for parent_value in$q$;
  apply_new constant text := $q$  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in$q$;

  target record;
  definition text;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.patches
    from (values
      ('vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(prepare_kind_old, prepare_kind_new))),
      ('vortex_record.save_named_action_set_announce(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(save_kind_old, save_kind_new))),
      ('vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(declare_old, declare_new),
          pg_catalog.jsonb_build_array(plan_old, plan_new),
          pg_catalog.jsonb_build_array(apply_old, apply_new)
        ))
    ) as candidate(procedure_id, patches)
  loop
    -- Patched as this migration's adapter role, then re-created under the
    -- function's own current owner so its grants, comment and OID stay put.
    definition := vortex_record.apply_named_action_copy_patch_internal(
      target.procedure_id, target.patches
    );
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    set local role vortex_record_adapter;
  end loop;
end
$migration$;

-- Migration-time patch guard; it has no runtime role once the callers above
-- have been rewritten.
drop function vortex_record.apply_named_action_copy_patch_internal(
  pg_catalog.regprocedure, jsonb
);

alter function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb
) owner to vortex_record_adapter;
alter function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  owner to vortex_record_adapter;

revoke all on function
  vortex_record.prepare_named_action_relationship_copies_internal(
    text, uuid, bigint, uuid, uuid, uuid, jsonb
  ),
  vortex_record.apply_named_action_relationship_copies_internal(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.prepare_named_action_relationship_copies_internal(
    text, uuid, bigint, uuid, uuid, uuid, jsonb
  ),
  vortex_record.apply_named_action_relationship_copies_internal(jsonb)
to vortex_record_adapter;

comment on function vortex_record.prepare_named_action_relationship_copies_internal(
  text, uuid, bigint, uuid, uuid, uuid, jsonb
) is
  'Private named-action step: re-derives every copy_relationships effect from the installed action and the supplied inputs, locks every target row and then every linked row in canonical order before any counter, data version or edge identity, and plans only the selected, declared, readable many-to-one subject edges the target does not already hold. Returns null when the action has no such effect, a refused outcome for a request it cannot honour, and raises only on a broken invariant.';
comment on function vortex_record.apply_named_action_relationship_copies_internal(jsonb) is
  'Private named-action step: writes each planned relationship copy through the ordinary relationship writer against its target''s current revision in ascending edge identity order, then records each changed target''s Activity and changed Event. Any refusal raises so the whole command rolls back.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
