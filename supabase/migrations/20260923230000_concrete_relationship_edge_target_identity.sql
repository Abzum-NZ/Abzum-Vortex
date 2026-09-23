-- #562: every stored relationship edge carries its own concrete declared
-- target record type, proven a member of the relationship's declared
-- `toRecordTypes`, and reads, Access traversal and total-field projection
-- decide from that same concrete identity instead of one fixed pair.
--
-- Before this migration the private facts loaders
-- (`vortex_record.load_record_access_facts_internal` and its
-- ownership-transfer twin) omitted a `link_to_one_of_several` relationship
-- from the facts entirely whenever it declared `toRecordTypes` instead of one
-- `toRecordType` (20260912011556:61-66 and 20260915090000:958). A route or an
-- inherited-ownership chain that only ever reaches its owning record through
-- such a relationship therefore always refused, and
-- `vortex_record.total_dependency_contract_internal` could never resolve a
-- total declared against one, because both the facts shape validator
-- (`vortex_access.evaluate_organization_record_access_internal`) and every
-- consumer of a relationship fact required the single `toModuleRootId` /
-- `toRecordTypeId` pair the loaders never produced for a polymorphic
-- declaration.
--
-- This migration replaces that singular pair with one uniform, non-empty
-- `toRecordTypes` array of `{moduleRootId, recordTypeId}` on every
-- relationship fact -- one entry for an ordinary relationship, several for a
-- polymorphic one -- and changes every current reader of that fact from an
-- exact-pair equality to a membership test against the array. An edge whose
-- resolved concrete target is not a member of its relationship's declared set
-- still refuses exactly as an undeclared type always has: the row-scope
-- witness match now tries every declared candidate target in turn and only
-- proceeds when one of them matches the edge's actual stored record scopes,
-- so a concrete type outside the declaration can never be substituted in.
--
-- `vortex_record.total_dependency_contract_internal` is also called by three
-- unrelated total-recalculation preflights that build their own single-entry
-- relationship array straight from the compiled catalogue's `toRecordType`
-- and are gated to single-target relationships before they ever reach it
-- (20260914013000, 20260921100000, 20260923170000); its patch below keeps
-- accepting their legacy `toRecordTypeId` pair alongside the new array so
-- none of the three needs to change.
--
-- Writing a new edge for a polymorphic relationship remains out of scope:
-- every current writer (`vortex_record.save_base_record`,
-- `save_named_action_set_fields_internal`, the named-action creation writer)
-- still refuses a `link_to_one_of_several` field change before any of the
-- patched functions below are reached, exactly as
-- `20260912011556_fixed_record_adapters.sql` already noted that edge writes
-- remain a separate piece of work. No relationship edge with a polymorphic
-- concrete target can exist yet, so this migration changes no stored data and
-- carries no backfill.
--
-- Every function below is patched in place from its current definition, as
-- `20260923220000_unify_relationship_edge_lock_order.sql` already does for
-- the edge-lock writers: the reviewed source text must occur exactly once, or
-- the migration aborts rather than silently skipping a caller.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.apply_concrete_relationship_target_patch_internal(
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
      message = 'Concrete relationship target patch is invalid';
  end if;
  occurrences := (
    pg_catalog.length(p_definition)
    - pg_catalog.length(pg_catalog.replace(p_definition, p_old, ''))
  ) / pg_catalog.length(p_old);
  if occurrences <> 1 then
    raise exception using errcode = '55000',
      message = 'Concrete relationship target patch does not match exactly once';
  end if;
  return pg_catalog.replace(p_definition, p_old, p_new);
end
$function$;

reset role;

-- Applies one or more named-owner-role patches to one function, asserting
-- each old fragment occurs exactly once before substituting it, then
-- re-creates the function under its own current owner so grants, comments and
-- OID stay exactly as they were.
do $migration$
declare
  loader_old constant text := $q$      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- One declared target only; see the header on polymorphic targets.
        if relationship_item ? 'toRecordType' then
          relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
            pg_catalog.lower(relationship_item ->> 'relationshipId'),
            pg_catalog.jsonb_build_object(
              'relationshipId', relationship_item -> 'relationshipId',
              'fromModuleRootId', module_root_value,
              'fromRecordTypeId', record_type_item -> 'recordTypeId',
              'toModuleRootId', relationship_item #> '{toRecordType,moduleRootId}',
              'toRecordTypeId', relationship_item #> '{toRecordType,recordTypeId}'
            )
          );
        end if;
      end loop;$q$;
  loader_new constant text := $q$      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, becomes one uniform
        -- `toRecordTypes` list, so a concrete edge target is proven a member
        -- of it rather than matched against one fixed pair.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', case
              when relationship_item ? 'toRecordType' then pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                  'moduleRootId', relationship_item #> '{toRecordType,moduleRootId}',
                  'recordTypeId', relationship_item #> '{toRecordType,recordTypeId}'
                )
              )
              else coalesce((
                select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'moduleRootId', target.value -> 'moduleRootId',
                  'recordTypeId', target.value -> 'recordTypeId'
                ) order by target.ordinality)
                from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes')
                  with ordinality as target(value, ordinality)
              ), '[]'::jsonb)
            end
          )
        );
      end loop;$q$;

  target record;
  definition text;
  owner_name name;
begin
  for target in
    select * from (values
      ('vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint)'::pg_catalog.regprocedure),
      ('vortex_record.load_record_access_facts_for_transfer_installation_internal(uuid,uuid,bigint,jsonb)'::pg_catalog.regprocedure)
    ) as candidate(procedure_id)
  loop
    definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    definition := vortex_record.apply_concrete_relationship_target_patch_internal(
      definition, loader_old, loader_new
    );
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

-- `vortex_access.evaluate_organization_record_access_internal`: the closed
-- facts-shape validator now requires the `toRecordTypes` array instead of the
-- singular `toModuleRootId` / `toRecordTypeId` pair, since both facts loaders
-- above now only ever produce the array.
do $migration$
declare
  validator_old constant text := $q$  -- Relationships: unique identity, well-formed endpoints.
  for relationship_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
  loop
    if pg_catalog.jsonb_typeof(relationship_item) <> 'object'
      or not (relationship_item ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toModuleRootId', 'toRecordTypeId'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(relationship_item) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toModuleRootId', 'toRecordTypeId'
        ])
      )
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromRecordTypeId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'toModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'toRecordTypeId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(relationship_item ->> 'relationshipId') = any (seen_relationship_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_relationship_ids := pg_catalog.array_append(
      seen_relationship_ids, pg_catalog.lower(relationship_item ->> 'relationshipId')
    );
  end loop;$q$;
  validator_new constant text := $q$  -- Relationships: unique identity, well-formed endpoints. `toRecordTypes`
  -- is every concrete declared target -- one entry for an ordinary
  -- relationship, several for a polymorphic one -- so a concrete edge target
  -- is proven a member of this list, never equal to one fixed pair.
  for relationship_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
  loop
    if pg_catalog.jsonb_typeof(relationship_item) <> 'object'
      or not (relationship_item ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(relationship_item) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toRecordTypes'
        ])
      )
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromRecordTypeId')
      or pg_catalog.jsonb_typeof(relationship_item -> 'toRecordTypes') <> 'array'
      or pg_catalog.jsonb_array_length(relationship_item -> 'toRecordTypes') = 0
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(relationship_item -> 'toRecordTypes') as target(value)
        where pg_catalog.jsonb_typeof(target.value) <> 'object'
          or not (target.value ?& array['moduleRootId', 'recordTypeId'])
          or exists (
            select 1 from pg_catalog.jsonb_object_keys(target.value) as supplied(key)
            where supplied.key <> all (array['moduleRootId', 'recordTypeId'])
          )
          or not vortex_context.is_non_nil_uuid(target.value ->> 'moduleRootId')
          or not vortex_context.is_non_nil_uuid(target.value ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(relationship_item ->> 'relationshipId') = any (seen_relationship_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_relationship_ids := pg_catalog.array_append(
      seen_relationship_ids, pg_catalog.lower(relationship_item ->> 'relationshipId')
    );
  end loop;$q$;

  procedure_id constant pg_catalog.regprocedure :=
    'vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'::pg_catalog.regprocedure;
  definition text;
  owner_name name;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_concrete_relationship_target_patch_internal(
    definition, validator_old, validator_new
  );
  select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
  from pg_catalog.pg_proc as procedure
  where procedure.oid = procedure_id;
  execute pg_catalog.format('set local role %I', owner_name);
  execute definition;
  reset role;
end
$migration$;

-- `vortex_access.evaluate_record_permission_row_scope_internal`: the
-- inherited-ownership chase and the relationship-route chase each try every
-- one of a relationship's declared targets in turn -- exactly the trusted
-- `record_relationship_witness_matches` comparison already made, repeated per
-- candidate -- and the route guard becomes a membership test.
do $migration$
declare
  declare_old constant text := $q$  chase_relationship jsonb;
  chase_edge jsonb;
  chase_edge_count integer;
  parent_record jsonb;$q$;
  declare_new constant text := $q$  chase_relationship jsonb;
  chase_edge jsonb;
  chase_edge_count integer;
  chase_target jsonb;
  chase_witness_ok boolean;
  parent_record jsonb;$q$;

  ownership_witness_old constant text := $q$        exit when not vortex_access.record_relationship_witness_matches(
          (chase_relationship ->> 'relationshipId')::uuid,
          (chase_relationship ->> 'fromModuleRootId')::uuid,
          (chase_relationship ->> 'fromRecordTypeId')::uuid,
          (chase_relationship ->> 'toModuleRootId')::uuid,
          (chase_relationship ->> 'toRecordTypeId')::uuid,
          (chase_edge ->> 'relationshipId')::uuid,
          (chase_edge ->> 'fromRecordId')::uuid,
          (chase_edge ->> 'toRecordId')::uuid,
          chase_scope,
          parent_scope,
          context_organization_id,
          p_application_root_id
        );$q$;
  ownership_witness_new constant text := $q$        chase_witness_ok := false;
        for chase_target in
          select value from pg_catalog.jsonb_array_elements(chase_relationship -> 'toRecordTypes') as item(value)
        loop
          if vortex_access.record_relationship_witness_matches(
            (chase_relationship ->> 'relationshipId')::uuid,
            (chase_relationship ->> 'fromModuleRootId')::uuid,
            (chase_relationship ->> 'fromRecordTypeId')::uuid,
            (chase_target ->> 'moduleRootId')::uuid,
            (chase_target ->> 'recordTypeId')::uuid,
            (chase_edge ->> 'relationshipId')::uuid,
            (chase_edge ->> 'fromRecordId')::uuid,
            (chase_edge ->> 'toRecordId')::uuid,
            chase_scope,
            parent_scope,
            context_organization_id,
            p_application_root_id
          ) then
            chase_witness_ok := true;
            exit;
          end if;
        end loop;
        exit when not chase_witness_ok;$q$;

  route_guard_old constant text := $q$    if relationship_decl is null
      or pg_catalog.lower(relationship_decl ->> 'toModuleRootId') <> pg_catalog.lower(target_type ->> 'moduleRootId')
      or pg_catalog.lower(relationship_decl ->> 'toRecordTypeId') <> pg_catalog.lower(target_type ->> 'recordTypeId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;$q$;
  route_guard_new constant text := $q$    if relationship_decl is null
      or not exists (
        select 1 from pg_catalog.jsonb_array_elements(relationship_decl -> 'toRecordTypes') as item(value)
        where pg_catalog.lower(item.value ->> 'moduleRootId') = pg_catalog.lower(target_type ->> 'moduleRootId')
          and pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(target_type ->> 'recordTypeId')
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;$q$;

  route_witness_old constant text := $q$      if not vortex_access.record_relationship_witness_matches(
        (relationship_decl ->> 'relationshipId')::uuid,
        (relationship_decl ->> 'fromModuleRootId')::uuid,
        (relationship_decl ->> 'fromRecordTypeId')::uuid,
        (relationship_decl ->> 'toModuleRootId')::uuid,
        (relationship_decl ->> 'toRecordTypeId')::uuid,
        (edge_item ->> 'relationshipId')::uuid,
        (edge_item ->> 'fromRecordId')::uuid,
        (edge_item ->> 'toRecordId')::uuid,
        source_record_scope,
        target_record_scope,
        context_organization_id,
        p_application_root_id
      ) then
        continue;
      end if;$q$;
  route_witness_new constant text := $q$      chase_witness_ok := false;
      for chase_target in
        select value from pg_catalog.jsonb_array_elements(relationship_decl -> 'toRecordTypes') as item(value)
      loop
        if vortex_access.record_relationship_witness_matches(
          (relationship_decl ->> 'relationshipId')::uuid,
          (relationship_decl ->> 'fromModuleRootId')::uuid,
          (relationship_decl ->> 'fromRecordTypeId')::uuid,
          (chase_target ->> 'moduleRootId')::uuid,
          (chase_target ->> 'recordTypeId')::uuid,
          (edge_item ->> 'relationshipId')::uuid,
          (edge_item ->> 'fromRecordId')::uuid,
          (edge_item ->> 'toRecordId')::uuid,
          source_record_scope,
          target_record_scope,
          context_organization_id,
          p_application_root_id
        ) then
          chase_witness_ok := true;
          exit;
        end if;
      end loop;
      if not chase_witness_ok then
        continue;
      end if;$q$;

  procedure_id constant pg_catalog.regprocedure := 'vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])'::pg_catalog.regprocedure;
  definition text;
  owner_name name;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_concrete_relationship_target_patch_internal(
    definition, declare_old, declare_new
  );
  definition := vortex_record.apply_concrete_relationship_target_patch_internal(
    definition, ownership_witness_old, ownership_witness_new
  );
  definition := vortex_record.apply_concrete_relationship_target_patch_internal(
    definition, route_guard_old, route_guard_new
  );
  definition := vortex_record.apply_concrete_relationship_target_patch_internal(
    definition, route_witness_old, route_witness_new
  );
  select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
  from pg_catalog.pg_proc as procedure
  where procedure.oid = procedure_id;
  execute pg_catalog.format('set local role %I', owner_name);
  execute definition;
  reset role;
end
$migration$;

-- `vortex_record.total_dependency_contract_internal`: a total's declared
-- relationship now resolves by membership in `toRecordTypes` when present,
-- alongside the legacy singular `toRecordTypeId` the three unrelated
-- recalculation preflights noted above still supply for a single-target
-- relationship, so neither of them needs to change.
do $migration$
declare
  lookup_old constant text := $q$  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(p_relationships) as item(value)
  where pg_catalog.lower(item.value ->> 'relationshipId') =
      pg_catalog.lower(relationship_id_value::text)
    and pg_catalog.lower(item.value ->> 'toRecordTypeId') =
      pg_catalog.lower(p_target_record_type_id::text);$q$;
  lookup_new constant text := $q$  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(p_relationships) as item(value)
  where pg_catalog.lower(item.value ->> 'relationshipId') =
      pg_catalog.lower(relationship_id_value::text)
    and (
      pg_catalog.lower(item.value ->> 'toRecordTypeId') =
        pg_catalog.lower(p_target_record_type_id::text)
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(item.value -> 'toRecordTypes') as target(value)
        where pg_catalog.lower(target.value ->> 'recordTypeId') =
          pg_catalog.lower(p_target_record_type_id::text)
      )
    );$q$;

  procedure_id constant pg_catalog.regprocedure :=
    'vortex_record.total_dependency_contract_internal(jsonb,jsonb,uuid,jsonb)'::pg_catalog.regprocedure;
  definition text;
  owner_name name;
begin
  definition := pg_catalog.pg_get_functiondef(procedure_id);
  definition := vortex_record.apply_concrete_relationship_target_patch_internal(
    definition, lookup_old, lookup_new
  );
  select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
  from pg_catalog.pg_proc as procedure
  where procedure.oid = procedure_id;
  execute pg_catalog.format('set local role %I', owner_name);
  execute definition;
  reset role;
end
$migration$;

-- Migration-time patch guard; it has no runtime role once every caller above
-- has been rewritten.
set local role vortex_record_adapter;
drop function vortex_record.apply_concrete_relationship_target_patch_internal(text, text, text);
reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
