-- #50 slice 2: execute the published `create_record` effect inside the existing
-- protected named-action transaction, freely mixed with `set_field` and
-- `announce_event`.
--
-- Three things this migration deliberately does NOT do:
--
--  * It does not route a created record through
--    `save_named_action_set_fields_internal`. That function is
--    one-record-per-command: it claims the command receipt for the record it
--    writes, stamps `record_id` on the receipt, consumes the command's single
--    `p_activity_id`/`p_occurrence_id`, and projects through the *subject's*
--    named declaration. Created records go through the explicit insert/link/
--    authorise path below instead.
--  * It does not prepare relationship totals twice. Two preparations are
--    deadlock-prone (each pass is only locally canonical) and numerically wrong
--    whenever the subject and a created record share a total parent, because
--    the second pass would be computed from a pre-mutation snapshot. One merged
--    closure is locked once and evaluated once.
--  * It does not generate any function body from another function's source
--    text. Every object here is written explicitly, per the #511 post-mortem in
--    `20260920140000_explicit_named_action_set_fields_writer.sql`. The two
--    remaining generated clones on this path are dropped rather than re-cloned.
--
-- Lock order. Existing mixed traffic relies on
--   L2 row `for update` closure pass  ->  L4 reference counters
--   ->  L5 link-target `for share`    ->  L6 relationship advisory key
-- (`20260914013000:436-450`, `20260913030000:430-439`, `:596-605`, `:634-637`;
-- ordinary create allocates every counter in `create_record_internal`'s field
-- loop before its relationship loop reaches the edge writer). A create-bearing
-- command touches more of those resources than any single ordinary command, so
-- `prepare_named_action_command_totals` pre-acquires all of them, before any
-- write, in exactly that order and in one canonical sequence per resource
-- class. Every later acquisition — including the subject writer's own edge
-- write and each creation's counter — is then a free re-take, and no new path
-- ever takes L6 before L4.
--
-- Authority. `write_relationship_value_internal` independently requires
-- ordinary `read` on every link target (`20260913030000:607-619`), which would
-- make "create a child under the subject" demand ordinary read on the subject
-- and contradict #50 section 4. The named-action edge writer below substitutes
-- the exact installed named authority for that one target — the command's own
-- subject — and takes no caller-supplied trust flag: it re-resolves the
-- installed action and re-evaluates the decision itself. Every other target
-- keeps the unchanged ordinary read check.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- ---------------------------------------------------------------------------
-- Creation plan: resolve every `create_record` target from the published
-- resolved reference, apply the slice's explicit refusals, and (when the
-- terminal writer calls it) re-derive the plan the caller claims to be
-- executing. Values themselves are enforced by the insert path, exactly as
-- `change_record` enforces `set_field` values today.
-- ---------------------------------------------------------------------------
create function vortex_record.named_action_creation_plan_internal(
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
  effect_value jsonb;
  effect_ordinal integer;
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

  -- Refusal 5, and the one place this slice narrows what an action may
  -- express. `save_named_action_set_fields_internal:591` writes the subject's
  -- own relationship edge inside the same call that claims the command
  -- receipt, so it necessarily takes the relationship advisory key (L6) before
  -- any creation can allocate a reference-number counter (L4). Ordinary create
  -- takes those in the opposite order (`20260913030000:787-806` before
  -- `:868-877`), which is a hard cycle: this command would hold
  -- `A(relS, X)` and wait for `C(storage(S), refField)` while a concurrent
  -- ordinary create of `S` linked to `X` holds that counter and waits for
  -- `A(relS, X)`. Lifting this needs an explicit named-action subject writer
  -- that allocates the creations' reference numbers between claiming the
  -- receipt and writing the subject's edges; that is deliberately not done
  -- here rather than hidden.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'create_record'
  ) and exists (
    select 1
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects') effect(value)
    join pg_catalog.jsonb_array_elements(
      action_context -> 'recordType' -> 'fields'
    ) field(value)
      on pg_catalog.lower(field.value ->> 'fieldId') =
        pg_catalog.lower(effect.value ->> 'fieldId')
    where effect.value ->> 'kind' = 'set_field'
      and field.value ->> 'type' in ('link', 'link_to_one_of_several')
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', 'create_with_subject_link_unsupported'
    );
  end if;

  for effect_value, effect_ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if effect_value ->> 'kind' <> 'create_record' then continue; end if;
    if effect_value #>> '{recordType,state}' is distinct from 'resolved'
      or not pg_catalog.pg_input_is_valid(
        effect_value #>> '{recordType,recordTypeId}', 'uuid'
      )
      or pg_catalog.jsonb_typeof(effect_value -> 'values') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    target_type_id := (effect_value #>> '{recordType,recordTypeId}')::uuid;
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
    -- `p_selected_group_id` is permanently null and a `team` target could only
    -- fail with `owner_unavailable` after its insert.
    if ownership_mode = 'team' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_owner_unsupported'
      );
    end if;
    -- Refusal 2: an `inherited` target derives its owner from one declared
    -- relationship, which the authored field map must name.
    if ownership_mode = 'inherited'
      and not (effect_value -> 'values') ? pg_catalog.lower(
        target_type ->> 'ownershipRelationshipId'
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
      );
    end if;

    for field_key in
      select pg_catalog.lower(item.value)
      from pg_catalog.jsonb_object_keys(effect_value -> 'values') item(value)
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
      -- Refusal 3: only the delivered #402 single-target to-one link semantics
      -- are implemented. Polymorphic targets remain #49 and must refuse, never
      -- be silently skipped.
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into relationship_value
        from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
        where pg_catalog.lower(item.value ->> 'fromFieldId') = field_key;
        if field_value ->> 'type' <> 'link'
          or relationship_value is null
          or not (relationship_value ? 'toRecordType')
          or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
          return pg_catalog.jsonb_build_object(
            'outcome', 'unsupported', 'reasonCode', 'create_target_relationship_unsupported'
          );
        end if;
      end if;
    end loop;

    create_targets := create_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', effect_ordinal,
        'recordTypeId', target_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_meta ->> 'storageScope',
        'ownershipMode', ownership_mode,
        'recordType', target_type
      )
    );
    expected_plan := expected_plan || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', effect_ordinal,
        'recordTypeId', pg_catalog.lower(target_type_id::text),
        'valueFieldIds', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
          from pg_catalog.jsonb_object_keys(effect_value -> 'values') item(value)
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

-- ---------------------------------------------------------------------------
-- Named-action edge writer. Byte-for-byte the reviewed
-- `write_relationship_value_internal` algorithm (`20260913030000:456-698`) with
-- exactly one substitution: the target eligibility decision for the command's
-- own subject. No boolean or other caller-supplied trust is accepted; the
-- authority is re-derived here from the installed action.
-- ---------------------------------------------------------------------------
create function vortex_record.write_named_action_relationship_value_internal(
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
  existing_other boolean;
  target_locked boolean;
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

  target_locked := false;
  execute pg_catalog.format(
    'select true from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active'' for share',
    target_meta ->> 'table'
  ) into target_locked using
    (source_context ->> 'organizationId')::uuid, target_record_id;
  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

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
      target_type_id, 'read', target_record_id, null
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

  -- Same key literal as `write_relationship_value_internal:634-637`; the
  -- command preflight has already taken it in canonical order, and the lock is
  -- re-entrant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_record.relationship:' || p_relationship_id::text || ':' || target_record_id::text,
    0
  ));
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

-- ---------------------------------------------------------------------------
-- Insert phase of a named-action creation: ownership derivation, field-map
-- validation and reference-number allocation, with no edge write and no Access
-- decision. Separating the phases is what keeps every reference counter (L4)
-- ahead of every relationship edge (L5/L6) across multiple creations.
-- Every defect raises, because a returned refusal after the subject write has
-- already happened would be committed by the request runner.
-- ---------------------------------------------------------------------------
create function vortex_record.insert_named_action_record_internal(
  p_record_type_id uuid,
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
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  app_scope uuid;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <> (
      select pg_catalog.count(distinct value)
      from pg_catalog.unnest(p_submitted_field_ids) as item(value)
    ) then
    raise exception using errcode = '22023', message = 'Named action creation is invalid';
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
  if pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = '55000', message = 'Named action creation target is unavailable';
  end if;
  context_value := meta -> 'context';
  record_type_value := meta -> 'recordType';
  ownership_mode := record_type_value ->> 'ownershipMode';
  app_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;

  if ownership_mode = 'organization_account' then
    owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
  elsif ownership_mode = 'team' then
    -- Refused by the creation plan; #50 forbids a caller-supplied final owner.
    raise exception using errcode = '42501',
      message = 'Named action creation owner is unavailable';
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
    where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
  ) then
    raise exception using errcode = '23514', message = 'Named action creation field is unknown';
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
        raise exception using errcode = '23514',
          message = 'Named action creation cannot submit a generated field';
      end if;
      input_value := pg_catalog.to_jsonb(vortex_record.allocate_reference_number_internal(
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'storageContractId')::uuid,
        field_id_value, app_scope, field_item -> 'settings'
      ));
      final_values := final_values || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_id_value::text), input_value
      );
    elsif final_values ? pg_catalog.lower(field_id_value::text) then
      input_value := final_values -> pg_catalog.lower(field_id_value::text);
      if (field_item ->> 'required')::boolean
        and pg_catalog.jsonb_typeof(input_value) = 'null' then
        raise exception using errcode = '23514',
          message = 'Named action creation is missing a required value';
      end if;
      if not vortex_record.canonical_record_value_matches(
        input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
      ) then
        raise exception using errcode = '23514',
          message = 'Named action creation value is invalid';
      end if;
    else
      if (field_item ->> 'required')::boolean then
        raise exception using errcode = '23514',
          message = 'Named action creation is missing a required value';
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
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, null, ''active'', 1,
       pg_catalog.statement_timestamp(), $9, pg_catalog.statement_timestamp(), $9%s)',
    meta ->> 'table',
    case when pg_catalog.cardinality(column_names) = 0 then ''
      else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
    case when pg_catalog.cardinality(column_values) = 0 then ''
      else ', ' || pg_catalog.array_to_string(column_values, ', ') end
  );
  execute insert_sql using
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'moduleRootId')::uuid, p_record_type_id,
    (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
    (meta ->> 'moduleReleaseRevision')::bigint,
    owner_account_id,
    (context_value ->> 'organizationAccountId')::uuid;

  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'storageContractId')::uuid, app_scope
  );
  return pg_catalog.jsonb_build_object(
    'recordId', record_id_value,
    'storageContractId', (meta ->> 'storageContractId')::uuid,
    'values', final_values
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- Authorisation phase. An exact create decision only exists after the insert
-- and after the edges, because record scope can depend on the derived owner and
-- on the new graph. A denial therefore raises and rolls the whole command back
-- (#50 section 8: "a later effect failure rolls back the operation without a
-- separate post-rollback refusal append").
-- ---------------------------------------------------------------------------
create function vortex_record.authorize_named_action_created_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_submitted_field_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  submitted_id uuid;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
  if pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = '42501',
      message = 'Named action creation authority is unavailable';
  end if;
  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'create', p_record_id, null
  );
  if loaded ->> 'outcome' <> 'loaded' then
    raise exception using errcode = '42501',
      message = 'Named action creation authority is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '42501',
      message = 'Named action creation authority is unavailable';
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
  foreach submitted_id in array p_submitted_field_ids loop
    if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text))
      or not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      raise exception using errcode = '42501',
        message = 'Named action creation field is not changeable';
    end if;
  end loop;
end
$function$;

alter function vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb) owner to vortex_record_adapter;
alter function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;
alter function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]) owner to vortex_record_adapter;
alter function vortex_record.authorize_named_action_created_record_internal(uuid,uuid,uuid[]) owner to vortex_record_adapter;

revoke all on function
  vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb),
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid),
  vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]),
  vortex_record.authorize_named_action_created_record_internal(uuid,uuid,uuid[])
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.named_action_creation_plan_internal(text,uuid,bigint,uuid,uuid,jsonb),
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid),
  vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]),
  vortex_record.authorize_named_action_created_record_internal(uuid,uuid,uuid[])
to vortex_record_adapter;

comment on function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge writer: identical to the ordinary edge writer except that the command subject is authorised by re-evaluating the exact installed named action rather than ordinary read.';

-- ---------------------------------------------------------------------------
-- One merged relationship-total closure for the whole command.
--
-- The subject keeps key 'root'; creation n takes key 'create:<n>' with no
-- recordId; every other record keeps `<typeId>:<recordId>`. A creation closure
-- that reaches the subject collapses onto 'root', so the subject can never be
-- both the command root and one of its own parents.
-- ---------------------------------------------------------------------------
create function vortex_record.named_action_command_closure_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_submitted_values jsonb,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subject_closure jsonb;
  creation_closure jsonb;
  creation jsonb;
  records jsonb;
  signatures jsonb;
  subject_key text;
  creation_key text;
  record_value jsonb;
  signature_value jsonb;
  old_key text;
  new_key text;
begin
  subject_closure := vortex_record.discover_relationship_total_closure_internal(
    p_catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
  );
  if subject_closure is null then return null; end if;
  records := subject_closure -> 'records';
  signatures := subject_closure -> 'signatures';
  subject_key := pg_catalog.lower(p_record_type_id::text) || ':' ||
    pg_catalog.lower(p_record_id::text);

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
      with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    creation_key := 'create:' || (creation ->> 'ordinal');
    creation_closure := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'create', (creation ->> 'recordTypeId')::uuid, null,
      creation -> 'values'
    );
    if creation_closure is null then return null; end if;
    for record_value in
      select item.value
      from pg_catalog.jsonb_array_elements(creation_closure -> 'records') item(value)
    loop
      old_key := record_value ->> 'recordKey';
      new_key := case when old_key = 'root' then creation_key
        when old_key = subject_key then 'root' else old_key end;
      if not exists (
        select 1 from pg_catalog.jsonb_array_elements(records) existing(value)
        where existing.value ->> 'recordKey' = new_key
      ) then
        records := records || pg_catalog.jsonb_build_array(
          record_value || pg_catalog.jsonb_build_object('recordKey', new_key)
        );
      end if;
    end loop;
    for signature_value in
      select item.value
      from pg_catalog.jsonb_array_elements(creation_closure -> 'signatures') item(value)
    loop
      signatures := signatures || pg_catalog.jsonb_build_array(
        signature_value || pg_catalog.jsonb_build_object(
          'from', case when signature_value ->> 'from' = 'root' then creation_key
            when signature_value ->> 'from' = subject_key then 'root'
            else signature_value ->> 'from' end,
          'to', case when signature_value ->> 'to' = 'root' then creation_key
            when signature_value ->> 'to' = subject_key then 'root'
            else signature_value ->> 'to' end
        )
      );
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) item(value)
    ), '[]'::jsonb)
  );
end
$function$;

-- Concrete link targets named by the subject's submitted link values and by
-- every creation's composed link values, with the storage contract needed to
-- order them with the closure records.
create function vortex_record.named_action_command_link_targets_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_submitted_values jsonb,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  sources jsonb;
  source_value jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_id text;
  target_value jsonb;
  target_type jsonb;
  targets jsonb := '[]'::jsonb;
begin
  sources := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id, 'values', p_submitted_values
  ));
  select sources || coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', (item.value ->> 'recordTypeId')::uuid,
      'values', item.value -> 'values'
    ) order by item.ordinality
  ), '[]'::jsonb)
  into sources
  from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
    with ordinality item(value, ordinality);

  for source_value in
    select item.value
    from pg_catalog.jsonb_array_elements(sources) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    select item.value into source_type
    from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') =
      pg_catalog.lower((source_value ->> 'recordTypeId')::uuid::text);
    if source_type is null then return null; end if;
    for relationship_value in
      select item.value
      from pg_catalog.jsonb_array_elements(source_type -> 'relationships') item(value)
      where item.value ? 'toRecordType'
      order by pg_catalog.lower(item.value ->> 'fromFieldId') collate "C",
        item.value ->> 'relationshipId'
    loop
      field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
      if not (source_value -> 'values') ? field_id then continue; end if;
      target_value := source_value -> 'values' -> field_id;
      if pg_catalog.jsonb_typeof(target_value) <> 'object' then continue; end if;
      if not pg_catalog.pg_input_is_valid(target_value ->> 'recordTypeId', 'uuid')
        or not pg_catalog.pg_input_is_valid(target_value ->> 'recordId', 'uuid') then
        return null;
      end if;
      select item.value into target_type
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower((target_value ->> 'recordTypeId')::uuid::text);
      if target_type is null then return null; end if;
      targets := targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'sourceRecordTypeId', (source_value ->> 'recordTypeId')::uuid,
        'fromFieldId', field_id,
        'relationshipId', (relationship_value ->> 'relationshipId')::uuid,
        'recordTypeId', (target_value ->> 'recordTypeId')::uuid,
        'recordId', (target_value ->> 'recordId')::uuid,
        'storageContractId', (target_type ->> 'storageContractId')::uuid
      ));
    end loop;
  end loop;
  return targets;
end
$function$;

-- One `for share` probe on a concrete link target, taking the same lock the
-- edge writer takes later (`20260913030000:596-605`), so that the whole command
-- acquires its rows in one canonical order.
create function vortex_record.share_lock_named_action_target_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  table_token text;
  locked boolean;
begin
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return false; end if;
  select stored.physical_table_token into table_token
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if table_token is null then return false; end if;
  context_value := vortex_access.validated_human_request_context();
  execute pg_catalog.format(
    'select true from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active'' for share',
    table_token
  ) into locked using (context_value ->> 'organizationId')::uuid, p_record_id;
  return coalesce(locked, false);
end
$function$;

-- ---------------------------------------------------------------------------
-- Command preflight. It reads, it locks, and it writes nothing: a returned
-- refusal or a `restart` is committed by the request runner, so nothing here
-- may leave a row behind. The one pre-existing exception is the delivered #41
-- content-free refusal Activity for a clean subject permission denial, which is
-- meant to commit.
--
-- Lock order, matching ordinary create (`L2 -> L4 -> L5/L6`): this pass takes
-- L2 (`for update` on every closure record) together with L5 (`for share` on
-- every concrete link target), in one canonical `(storageContractId, recordId)`
-- sequence. Reference counters (L4) and relationship advisory keys (L6) are NOT
-- taken here, because both are writes or would precede L4; the terminal writer
-- takes every counter before every edge instead.
-- ---------------------------------------------------------------------------
create function vortex_record.prepare_named_action_command_totals(
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
  access_loaded jsonb;
  access_decision jsonb;
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
  if exists (
    select 1 from vortex_record.named_action_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
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
  -- Before-save Rule execution is #58's. The delivered set/announce path defers
  -- to the terminal writer's `contributes_to_total` probe; a create-bearing
  -- command refuses explicitly instead of being silently skipped.
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
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
      (lock_entry ->> 'recordId')::uuid, null
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
  if exists (
    select 1 from vortex_record.named_action_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
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
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
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
        and pg_catalog.lower(item.value #>> '{toRecordType,recordTypeId}') =
          pg_catalog.lower(prepared_record ->> 'recordTypeId');
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
  when no_data_found or too_many_rows or check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

-- ---------------------------------------------------------------------------
-- Terminal writer. One transaction, fixed order:
--   1. receipt-existence probe (replay short-circuits before any creation)
--   2. creation plan re-derived from the installed action, then the merged
--      preparation re-run by the writer itself, so closure identity, revisions
--      and the generated-field set never depend on caller-controlled state
--   3. the subject write, which claims the receipt
--   4. every creation inserted (each allocating its reference numbers)
--   5. every creation edge, in one canonical order, after all inserts
--   6. every creation authorised, audited and announced
--   7. parent totals
-- Steps 4-7 raise on any failure. A returned refusal there would be committed
-- by the request runner, which is why nothing after step 3 returns one.
-- ---------------------------------------------------------------------------
create function vortex_record.save_named_action_effects_with_relationship_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb,
  p_declared_occurrence_ids jsonb,
  p_creations jsonb,
  p_creation_occurrence_ids jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_inputs jsonb
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
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer;
  preparation_value jsonb;
  result_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  relationship_value jsonb;
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
  inserted_value jsonb;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  changed_field_ids uuid[];
  occurrence_id_value uuid;
  event_result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array'
    or pg_catalog.jsonb_typeof(p_creations) <> 'array'
    or pg_catalog.jsonb_typeof(p_creation_occurrence_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_creations) <>
      pg_catalog.jsonb_array_length(p_creation_occurrence_ids) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  creation_count := pg_catalog.jsonb_array_length(p_creations);
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;

  if not exists (
    select 1 from vortex_record.named_action_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
    creation_plan := vortex_record.named_action_creation_plan_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_creations
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
      p_submitted_values, p_creations, p_activity_id, p_action_owner_kind,
      p_action_owner_id, p_action_release_revision, p_action_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' = 'defer' and exists (
      select 1 from vortex_record.named_action_command_receipts receipt
      where receipt.organization_id = context_organization_id
        and receipt.application_root_id = context_application_id
        and receipt.actor_organization_account_id =
          (context_value ->> 'organizationAccountId')::uuid
        and receipt.command_id = p_command_id
    ) then
      preparation_value := null;
    elsif preparation_value ->> 'outcome' = 'defer' then
      -- Preserved unchanged from `save_base_record_with_relationship_totals`
      -- (`20260914013000:817-904`): with an installed Rule the closure is not
      -- computed, so a command that would move a total must refuse rather than
      -- silently skip it. A create-bearing command already refused inside the
      -- preparation, so only the delivered set/announce shape reaches here.
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
        for relationship_value in
          select item.value
          from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
          where item.value ? 'toRecordType'
            and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
        loop
          select item.value into target_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(relationship_value #>> '{toRecordType,recordTypeId}');
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
              pg_catalog.jsonb_build_array(relationship_value || pg_catalog.jsonb_build_object(
                'toRecordTypeId', relationship_value #> '{toRecordType,recordTypeId}'
              )),
              (target_type ->> 'recordTypeId')::uuid, total_field
            );
            for dependency_field_id in
              select item.value
              from pg_catalog.jsonb_array_elements_text(
                dependency_contract -> 'sourceFieldIds'
              ) item(value)
            loop
              if p_final_values ? dependency_field_id and
                p_final_values -> dependency_field_id is distinct from
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
      if pg_catalog.jsonb_array_length(p_parent_mutations) = 0 then
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
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) = 'object'
        and item.value ?& array[
          'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
        ]
        and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
      if supplied_parents is distinct from expected_parents
        or pg_catalog.jsonb_array_length(supplied_parents) <>
          pg_catalog.jsonb_array_length(p_parent_mutations) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    end if;
  end if;

  result_value := vortex_record.save_named_action_set_announce(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_submitted_values, p_final_values, p_activity_id, p_occurrence_id,
    p_declared_occurrence_ids, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_inputs
  );
  -- The subject writer reports 'saved' when it wrote the subject and
  -- 'completed' when the action had nothing to write to it. Both are a claimed
  -- receipt and a committed subject step; only a replay short-circuits here.
  if result_value ->> 'outcome' not in ('saved', 'completed')
    or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Step 4: every insert, in authored effect order, before any edge. Each
    -- allocates its reference numbers (L4); keeping the whole set ahead of the
    -- edge pass is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Step 5: every edge, in one canonical order across all creations. The
    -- ordinary update writer iterates its own edges `order by fieldId`
    -- (`20260920140000:586-589`); matching that inside each source record type
    -- keeps the two paths consistent on the shared advisory key.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.source_record_type_id, entry.from_field_id collate "C",
        entry.target_record_id
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
      from pg_catalog.jsonb_array_elements(p_creations) creation_item(value)
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
        p_action_owner_kind, p_action_owner_id, p_action_release_revision,
        p_action_id, p_record_type_id, p_record_id
      );
    end loop;

    -- Step 6: the exact create decision only exists now, with the derived owner
    -- and the complete new graph in place. A denial raises, rolling the whole
    -- command back with no post-rollback refusal Activity (#50 section 8).
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      perform vortex_record.authorize_named_action_created_record_internal(
        (creation ->> 'recordTypeId')::uuid, created_record_id, submitted_field_ids
      );
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(p_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(p_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_event.append_record_occurrences(
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
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023',
        message = 'Relationship total parent mutation is incomplete';
    end if;
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
  return result_value;
end
$function$;

alter function vortex_record.named_action_command_closure_internal(jsonb,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;
alter function vortex_record.named_action_command_link_targets_internal(jsonb,uuid,jsonb,jsonb) owner to vortex_record_adapter;
alter function vortex_record.share_lock_named_action_target_internal(jsonb,uuid,uuid) owner to vortex_record_adapter;
alter function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) owner to vortex_record_adapter;
alter function vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function
  vortex_record.named_action_command_closure_internal(jsonb,uuid,uuid,jsonb,jsonb),
  vortex_record.named_action_command_link_targets_internal(jsonb,uuid,jsonb,jsonb),
  vortex_record.share_lock_named_action_target_internal(jsonb,uuid,uuid),
  vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid),
  vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.named_action_command_closure_internal(jsonb,uuid,uuid,jsonb,jsonb),
  vortex_record.named_action_command_link_targets_internal(jsonb,uuid,jsonb,jsonb),
  vortex_record.share_lock_named_action_target_internal(jsonb,uuid,uuid)
to vortex_record_adapter;
grant execute on function
  vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid),
  vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)
to vortex_runtime;

comment on function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';
comment on function vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb) is
  'Protected named action composed with created records, their edges, authority, Activity and Events, and revision-checked parent totals, in one transaction.';

-- ---------------------------------------------------------------------------
-- Admit `create_record` in the two guards that refuse it today, and return the
-- resolved creation targets so the runtime can compose each authored field map
-- against the target record type. Both bodies are otherwise unchanged from
-- `20260915020000:233-377` and `20260915030000:180-353`.
-- ---------------------------------------------------------------------------
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
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  fingerprint_value text;
  receipt vortex_record.named_action_command_receipts%rowtype;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  projection jsonb;
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
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );
  select stored.* into receipt
  from vortex_record.named_action_command_receipts stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id;
  if found then
    if receipt.command_fingerprint is distinct from fingerprint_value
      or receipt.action_owner_kind is distinct from p_action_owner_kind
      or receipt.action_owner_id is distinct from p_action_owner_id
      or receipt.action_release_revision is distinct from p_action_release_revision
      or receipt.action_id is distinct from p_action_id
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt.state <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
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
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'effects') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'effects'
      ) item(value)
      where item.value ->> 'kind' not in ('set_field', 'create_record', 'announce_event')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id,
    case when p_preview then null else p_expected_concurrency_number end
  );
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
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
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
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
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

create or replace function vortex_record.save_named_action_set_announce(
  p_command_id uuid, p_record_type_id uuid, p_record_id uuid,
  p_expected_concurrency_number bigint, p_submitted_values jsonb,
  p_final_values jsonb, p_activity_id uuid, p_standard_occurrence_id uuid,
  p_declared_occurrence_ids jsonb, p_action_owner_kind text,
  p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  result_value jsonb;
  event_result jsonb;
  fingerprint_value text;
  inserted_command_id uuid;
  receipt vortex_record.named_action_command_receipts%rowtype;
  set_field_ids jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'effects'
      ) effect(value)
      where effect.value ->> 'kind' not in ('set_field', 'create_record', 'announce_event')
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'unsupported');
  end if;
  select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
  into set_field_ids
  from (
    select distinct pg_catalog.lower(effect.value ->> 'fieldId') as field_id
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects') effect(value)
    where effect.value ->> 'kind' = 'set_field'
  ) fields;
  if pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_declared_occurrence_ids) is distinct from 'array'
    or set_field_ids is distinct from coalesce((
      select pg_catalog.jsonb_agg(key order by key collate "C")
      from pg_catalog.jsonb_object_keys(p_submitted_values) key
    ), '[]'::jsonb)
    or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
      pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  -- A create-only action whose created record moves one of the subject's own
  -- totals still has to write the subject. The fixed writer already accepts a
  -- final-value map of generated fields with an empty submitted-field set
  -- (`20260912011556:1149-1192`), so the only change here is reaching it when
  -- `p_final_values` is non-empty rather than only when a `set_field` exists.
  if pg_catalog.jsonb_array_length(set_field_ids) > 0 or p_final_values <> '{}'::jsonb then
    result_value := vortex_record.save_named_action_set_fields_internal(
      p_command_id, 'update', p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_final_values, null,
      p_activity_id, p_standard_occurrence_id, p_action_owner_kind,
      p_action_owner_id, p_action_release_revision, p_action_id, p_inputs
    );
    if result_value ->> 'outcome' <> 'saved'
      or coalesce((result_value ->> 'replayed')::boolean, false) then
      return result_value;
    end if;
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', p_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_array_length(event_result) <>
      pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    return result_value;
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
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
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );
  insert into vortex_record.named_action_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, command_fingerprint, action_owner_kind, action_owner_id,
    action_release_revision, action_id, record_type_id, record_id, state
  ) values (
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    p_command_id, fingerprint_value, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id, 'pending'
  ) on conflict do nothing returning command_id into inserted_command_id;
  if inserted_command_id is null then
    select stored.* into strict receipt
    from vortex_record.named_action_command_receipts stored
    where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_id = p_command_id for update;
    if receipt.command_fingerprint is distinct from fingerprint_value then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt.state <> 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    return vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
  end if;
  perform vortex_record.append_named_action_activity_internal(
    p_activity_id, p_record_id, array[]::uuid[], 'completed'
  );
  event_result := vortex_record.append_declared_named_action_occurrences_internal(
    (action_context ->> 'storageContractId')::uuid, p_record_id,
    action_context -> 'eventDescriptors', p_declared_occurrence_ids,
    loaded -> 'fieldValues'
  );
  if pg_catalog.jsonb_array_length(event_result) <>
    pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
    raise exception using errcode = '55000',
      message = 'Named action declared Event append failed';
  end if;
  update vortex_record.named_action_command_receipts stored
  set state = 'completed', concurrency_number = p_expected_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = 'Named action receipt is stale';
  end if;
  result_value := vortex_record.project_named_action_record_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id
  );
  if result_value ->> 'outcome' <> 'completed' then
    raise exception using errcode = '55000',
      message = 'Named action Record projection is unavailable';
  end if;
  return result_value || pg_catalog.jsonb_build_object('replayed', false);
end
$function$;

-- The last two generated clones on this path. They are replaced by the explicit
-- merged preflight and terminal writer above, so they are dropped rather than
-- re-cloned (#511 precedent). `load_named_action_facts_internal` remains
-- generated and is untouched by this slice.
drop function vortex_record.save_named_action_set_announce_with_relationship_totals(
  uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb,jsonb,text,uuid,bigint,uuid,jsonb
);
drop function vortex_record.prepare_named_action_relationship_totals(
  uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,text,uuid,bigint,uuid
);

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
