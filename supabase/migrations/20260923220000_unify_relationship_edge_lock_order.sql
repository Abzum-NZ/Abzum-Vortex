-- #561: one shared relationship edge identity and lock order for every
-- current relationship mutation path.
--
-- Before this migration `write_relationship_value_internal` and its
-- named-action twin keyed their transaction advisory lock on
-- `relationship_id || ':' || target_record_id` only. The source participant
-- was unkeyed, the target was not a permanent storage identity, clearing a
-- link took no edge lock at all, and each writer loop acquired its edges in a
-- different order (definition order on create, field order on update, source
-- type and field order in the named creation pass).
--
-- Identity. One participant of one edge is keyed by its permanent
-- relationship, storage contract and record identities
-- (`relationship_edge_record_identity_internal`). One edge mutation locks the
-- source participant and, when it installs an edge, the new target
-- participant (`relationship_edge_lock_identities_internal`). The source key
-- covers every edge the source owns under that relationship, including the
-- edge being replaced or cleared; the old target is deliberately not keyed,
-- because a recursive delete holds that parent while it visits further
-- children and would otherwise block every concurrent move away from it.
--
-- Order. Relationship edge identities are the last lock class, as the
-- reviewed named-action lock order (`20260921100000:24-35`) already requires:
-- a writer takes them only after its caller has locked the source row, after
-- its own share lock on the new target row, and after any record data-version
-- bump it makes (moved ahead of the edge identities here, and ahead of the
-- relationship loop in `create_record_internal`, to match the named creation
-- path, which bumps at insert before its edge pass). Every participant thus
-- already holds a row lock when its identity is requested, so identities only
-- contend between writers sharing a target, and never ahead of a row, counter
-- or data-version lock. Relationship totals and the recursive delete traversal
-- do not take edge identities ahead of their row pass: that would invert the
-- order against every writer and reintroduce the documented counter/edge cycle
-- for named creations. Their locked concrete closure rows remain the guard
-- against calculating from a partial edge set, and every edge they change goes
-- through the shared writers. The System deadline closure changes no edge and
-- is unchanged.
--
-- Within the class, `acquire_relationship_edge_locks_internal` acquires in one
-- ascending `collate "C"` order across the whole transaction. An identity that
-- sorts after everything already taken waits normally; one that would be
-- acquired out of that order is only tried, and a held one is a bounded
-- `40001` conflict instead of a wait that could close a cycle. Every writer
-- loop is ordered by relationship identity, and the named creation edge pass
-- by relationship and target, so ordinary saves stay in order.
--
-- The writers, the three writer loops and the named creation edge pass are
-- patched in place from their current definitions. Each replacement asserts
-- that the reviewed source text occurs exactly once, so any drift fails the
-- migration rather than silently skipping a caller. Ownership, grants,
-- `security definer`, authorization, revision and journal behavior are
-- otherwise unchanged.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.relationship_edge_record_identity_internal(
  p_relationship_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_relationship_id is null or p_storage_contract_id is null or p_record_id is null
    or p_relationship_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Relationship edge participant identity is invalid';
  end if;
  return pg_catalog.concat_ws(
    ':',
    'vortex_record.relationship_edge',
    pg_catalog.lower(p_relationship_id::text),
    pg_catalog.lower(p_storage_contract_id::text),
    pg_catalog.lower(p_record_id::text)
  );
end
$function$;

create function vortex_record.relationship_edge_lock_identities_internal(
  p_relationship_id uuid,
  p_from_storage_contract_id uuid,
  p_from_record_id uuid,
  p_to_storage_contract_id uuid,
  p_to_record_id uuid
)
returns text[]
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  source_identity text;
  target_identity text;
begin
  if (p_to_storage_contract_id is null) <> (p_to_record_id is null) then
    raise exception using errcode = '22023',
      message = 'Relationship edge target identity is incomplete';
  end if;
  source_identity := vortex_record.relationship_edge_record_identity_internal(
    p_relationship_id, p_from_storage_contract_id, p_from_record_id
  );
  if p_to_storage_contract_id is null then
    return array[source_identity];
  end if;
  target_identity := vortex_record.relationship_edge_record_identity_internal(
    p_relationship_id, p_to_storage_contract_id, p_to_record_id
  );
  if source_identity = target_identity then
    return array[source_identity];
  end if;
  return case when source_identity collate "C" < target_identity collate "C"
    then array[source_identity, target_identity]
    else array[target_identity, source_identity] end;
end
$function$;

-- The transaction's highest acquired identity is kept in a transaction-local
-- setting bound to the top-level transaction id, so a value left by another
-- transaction on the same session is never trusted. Subtransaction rollback
-- reverts the setting together with the locks acquired inside it.
create function vortex_record.acquire_relationship_edge_locks_internal(
  p_identities text[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  transaction_key text := pg_catalog.pg_current_xact_id()::text;
  stored_value text;
  high_water text;
  identity_value text;
begin
  if p_identities is null
    or pg_catalog.array_position(p_identities, null::text) is not null then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock set is invalid';
  end if;
  stored_value := pg_catalog.current_setting(
    'vortex_record.relationship_edge_lock_high_water', true
  );
  if stored_value is not null
    and pg_catalog.split_part(stored_value, '|', 1) = transaction_key then
    high_water := pg_catalog.substr(
      stored_value, pg_catalog.length(transaction_key) + 2
    );
  end if;
  for identity_value in
    select distinct item.value collate "C"
    from pg_catalog.unnest(p_identities) as item(value)
    order by 1
  loop
    if high_water is null or identity_value collate "C" > high_water collate "C" then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(identity_value, 0)
      );
      high_water := identity_value;
      perform pg_catalog.set_config(
        'vortex_record.relationship_edge_lock_high_water',
        transaction_key || '|' || high_water, true
      );
    elsif not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(identity_value, 0)
    ) then
      raise exception using errcode = '40001',
        message = 'Relationship edge lock order conflict';
    end if;
  end loop;
end
$function$;

-- Assert that the reviewed source text is still exactly present once, then
-- substitute it. The migration aborts instead of silently skipping a caller.
create function vortex_record.apply_relationship_edge_lock_patch_internal(
  p_definition text,
  p_old text,
  p_new text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  occurrences integer;
begin
  if p_definition is null or p_old is null or p_new is null or p_old = '' then
    raise exception using errcode = '22023',
      message = 'Relationship edge lock patch is invalid';
  end if;
  occurrences := (
    pg_catalog.length(p_definition)
    - pg_catalog.length(pg_catalog.replace(p_definition, p_old, ''))
  ) / pg_catalog.length(p_old);
  if occurrences <> 1 then
    raise exception using errcode = '55000',
      message = 'Relationship edge lock patch does not match exactly once';
  end if;
  return pg_catalog.replace(p_definition, p_old, p_new);
end
$function$;

do $migration$
declare
  definition text;

  -- Both writers: clearing a link.
  clear_old constant text := $q$    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    delete from vortex_record.relationship_edges as edge$q$;
  clear_new constant text := $q$    if (field_value ->> 'required')::boolean then
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
    delete from vortex_record.relationship_edges as edge$q$;
  named_clear_new constant text := $q$    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge$q$;
  clear_version_old constant text := $q$    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    if p_increment_source_revision then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    return;$q$;
  clear_version_new constant text := $q$    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Relationship source record changed';
    end if;
    return;$q$;

  -- Both writers: installing an edge. The target is share-locked and eligible.
  set_old constant text := $q$  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_record.relationship:' || p_relationship_id::text || ':' || target_record_id::text,
    0
  ));$q$;
  set_new constant text := $q$  -- The target row is share-locked and eligible. The source data version is
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
  );$q$;
  set_version_old constant text := $q$  if p_increment_source_revision then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
end$q$;
  set_version_new constant text := $q$end$q$;
  named_set_old constant text := $q$  -- Same key literal as `write_relationship_value_internal:634-637`; the
  -- command preflight has already taken it in canonical order, and the lock is
  -- re-entrant.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_record.relationship:' || p_relationship_id::text || ':' || target_record_id::text,
    0
  ));$q$;
  named_set_new constant text := $q$  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );$q$;

  -- save_base_record / save_named_action_set_fields_internal update loops.
  update_loop_old constant text := $q$        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by item.value ->> 'fieldId'
      loop$q$;
  update_loop_new constant text := $q$        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop$q$;

  -- create_record_internal: data version, then edges in identity order.
  create_version_old constant text := $q$    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,$q$;
  create_version_new constant text := $q$    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,$q$;
  create_loop_old constant text := $q$    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
    loop$q$;
  create_loop_new constant text := $q$    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop$q$;

  -- save_named_action_effects_with_relationship_totals creation edge pass.
  named_pass_comment_old constant text := $q$    -- Step 5: every edge, in one canonical order across all creations. The
    -- ordinary update writer iterates its own edges `order by fieldId`
    -- (`20260920140000:586-589`); matching that inside each source record type
    -- keeps the two paths consistent on the shared advisory key.$q$;
  named_pass_comment_new constant text := $q$    -- Step 5: every edge, in one canonical order across all creations: by
    -- relationship, then target, matching the ascending relationship edge
    -- identity order every ordinary writer loop uses.$q$;
  named_pass_order_old constant text := $q$      order by entry.source_record_type_id, entry.from_field_id collate "C",
        entry.target_record_id$q$;
  named_pass_order_new constant text := $q$      order by entry.relationship_id, entry.target_record_id, entry.ordinal$q$;
begin
  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean)'::pg_catalog.regprocedure
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, clear_version_old, clear_version_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, clear_old, clear_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, set_version_old, set_version_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, set_old, set_new
  );
  execute definition;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid)'::pg_catalog.regprocedure
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, clear_old, named_clear_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, named_set_old, named_set_new
  );
  execute definition;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.save_base_record(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid)'::pg_catalog.regprocedure
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, update_loop_old, update_loop_new
  );
  execute definition;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, update_loop_old, update_loop_new
  );
  execute definition;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid)'::pg_catalog.regprocedure
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, create_version_old, create_version_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, create_loop_old, create_loop_new
  );
  execute definition;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.save_named_action_effects_with_relationship_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, named_pass_comment_old, named_pass_comment_new
  );
  definition := vortex_record.apply_relationship_edge_lock_patch_internal(
    definition, named_pass_order_old, named_pass_order_new
  );
  execute definition;
end
$migration$;

-- Migration-time patch guard; it has no runtime role once the callers above
-- have been rewritten.
drop function vortex_record.apply_relationship_edge_lock_patch_internal(text, text, text);

revoke all on function vortex_record.relationship_edge_record_identity_internal(uuid, uuid, uuid),
  vortex_record.relationship_edge_lock_identities_internal(uuid, uuid, uuid, uuid, uuid),
  vortex_record.acquire_relationship_edge_locks_internal(text[])
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.relationship_edge_record_identity_internal(uuid, uuid, uuid),
  vortex_record.relationship_edge_lock_identities_internal(uuid, uuid, uuid, uuid, uuid),
  vortex_record.acquire_relationship_edge_locks_internal(text[])
to vortex_record_adapter;

comment on function vortex_record.relationship_edge_record_identity_internal(uuid, uuid, uuid) is
  'Permanent identity of one participant of one relationship edge: relationship, storage contract and record. Malformed or sentinel identities raise.';
comment on function vortex_record.relationship_edge_lock_identities_internal(uuid, uuid, uuid, uuid, uuid) is
  'Sorted participant identities one relationship edge mutation locks: the source always, and the new target when an edge is installed.';
comment on function vortex_record.acquire_relationship_edge_locks_internal(text[]) is
  'Acquires relationship edge participant identities as transaction advisory locks in one ascending collate "C" order per transaction; an out-of-order identity that is held elsewhere is a bounded 40001 conflict, never a wait.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
