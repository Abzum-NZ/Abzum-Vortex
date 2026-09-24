-- #578: protected saves hand the exact release's before-save rule graphs to Record,
-- and every rule the save cannot evaluate refuses it instead of being skipped.
--
-- Record evaluates compiled before-save graphs (`evaluateBeforeSaveRuleGraphs`)
-- inside the save transaction, but the preparations never returned the graphs or
-- the release they came from. The two preparations that Record now completes with
-- rules — the ordinary base save (`prepare_base_record_save`) and the named-action
-- set/announce preparation (`prepare_named_action_set_announce_internal`) —
-- additionally return `beforeSaveRules`: the exact Module release identity the save
-- already resolved (`moduleRootId`, `releaseRevision`) and every rule of that
-- release whose subject is the saved record type. They are read here, under the
-- preparation's own owner, from the same immutable release row the save resolved:
-- no second or looser definition read, and never from caller input. The general
-- definition consumer read is a system-context, request-role reader and is not
-- callable from the runtime role, so the private helper below reads the same stored
-- canonical content. Record parses each returned rule as a compiled graph and
-- refuses the save when any is not one (a legacy rule shape it cannot evaluate).
--
-- The existing "rules are unsupported" guards compared a rule's `recordTypeId`, but
-- every rule shape (compiled graph and legacy Application/Module rule definition)
-- names its record type as `subjectRecordTypeId`, so the guards never matched and
-- an Application's rules on a record type were silently skipped by both saves.
-- They now match `subjectRecordTypeId`:
--
-- * `prepare_base_record_save` refuses (`unsupported`) when the installed
--   Application release carries a rule for the record type. Its owning Module
--   release's rules are no longer a refusal here: they are the `beforeSaveRules`
--   Record evaluates.
-- * `resolve_named_action_context_internal` reports `rulesUnsupported` when the
--   Application release, or any bound Module release other than the subject's
--   owning one, carries a rule for the subject. The owning Module release's rules
--   are again the `beforeSaveRules` Record evaluates; the named-action preparation
--   and terminal writer keep refusing on `rulesUnsupported`.
--
-- Nothing else changes. Relationship-total preparation keeps deferring whenever
-- any rule is installed and its writers keep refusing a defer that would move a
-- total, so a rule-bearing save can never skip a total. The paths that refuse when
-- any rule is installed (named-action record creation, deadline transition
-- closure, relationship-total closures of protected delete and recovery) are
-- untouched and stay fail-closed.
--
-- The three functions are patched in place from their live definitions: each
-- reviewed fragment must occur exactly once, and a definition already carrying
-- this migration's marker aborts, so nothing is patched twice or skipped.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.before_save_rules_for_record_type_internal(
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  release_content jsonb;
begin
  if p_module_root_id is null or p_module_release_revision is null
    or p_record_type_id is null then
    raise exception using errcode = '22023', message = 'Before-save rule selector is invalid';
  end if;
  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision;
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'releaseRevision', p_module_release_revision,
    'rules', coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.value ->> 'ruleId')
      from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'rules', '[]'::jsonb)
      ) as item(value)
      where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
        pg_catalog.lower(p_record_type_id::text)
    ), '[]'::jsonb)
  );
end
$function$;

do $migration$
declare
  -- The base save's prepared outcome carries the owning release's rules.
  base_return_old constant text := $q$    'outcome', 'prepared',
    'recordType', meta -> 'recordType',$q$;
  base_return_new constant text := $q$    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),$q$;

  -- The base save's rule guard: the owning Module release's rules are now
  -- evaluated by Record, and an Application rule on the record type refuses.
  base_guard_old constant text := $q$  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(module_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
  );$q$;
  base_guard_new constant text := $q$  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );$q$;

  -- The named-action preparation's outcome carries the subject's owning release's rules.
  action_return_old constant text := $q$    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',$q$;
  action_return_new constant text := $q$    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- #578: the owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),$q$;

  -- The named-action resolver's rule guards: a rule for the subject in any bound
  -- Module release other than the owning one, or in the Application release, is
  -- one Record does not evaluate.
  resolver_module_old constant text := $q$    if exists (
      select 1 from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'rules', '[]'::jsonb)
      ) as item(value)
      where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
    ) then
      rules_unsupported := true;
    end if;$q$;
  resolver_module_new constant text := $q$    -- #578: the owning Module release's rules are evaluated by Record
    -- (`beforeSaveRules`); a rule for the subject in any other release is not.
    if (binding_value ->> 'moduleRootId')::uuid <>
        (base_context ->> 'moduleRootId')::uuid
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(
          coalesce(release_content -> 'rules', '[]'::jsonb)
        ) as item(value)
        where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text)
      ) then
      rules_unsupported := true;
    end if;$q$;
  resolver_application_old constant text := $q$  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
  ) then
    rules_unsupported := true;
  end if;$q$;
  resolver_application_new constant text := $q$  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  ) then
    rules_unsupported := true;
  end if;$q$;

  target record;
  patch jsonb;
  definition text;
  old_text text;
  occurrences integer;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.patches
    from (values
      ('vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(base_return_old, base_return_new),
          pg_catalog.jsonb_build_array(base_guard_old, base_guard_new)
        )),
      ('vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(action_return_old, action_return_new)
        )),
      ('vortex_record.resolve_named_action_context_internal(text,uuid,bigint,uuid,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(resolver_module_old, resolver_module_new),
          pg_catalog.jsonb_build_array(resolver_application_old, resolver_application_new)
        ))
    ) as candidate(procedure_id, patches)
  loop
    definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    if definition is null then
      raise exception using errcode = '55000',
        message = 'Before-save rule patch target is missing', detail = target.procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
    if pg_catalog.strpos(definition, '#578:') <> 0 then
      raise exception using errcode = '55000',
        message = 'Before-save rule patch target is already patched',
        detail = target.procedure_id::text;
    end if;
    for patch in
      select item.value from pg_catalog.jsonb_array_elements(target.patches) as item(value)
    loop
      old_text := patch ->> 0;
      occurrences := (
        pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
      ) / pg_catalog.length(old_text);
      if occurrences <> 1 then
        raise exception using errcode = '55000',
          message = 'Before-save rule patch does not match exactly once',
          detail = target.procedure_id::text;
      end if;
      definition := pg_catalog.replace(definition, old_text, patch ->> 1);
    end loop;
    -- Re-created under the function's own current owner so its grants, comment
    -- and OID stay put.
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    set local role vortex_record_adapter;
  end loop;
end
$migration$;

alter function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid)
  to vortex_record_adapter;

comment on function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid) is
  'Private save step: returns the exact Module release identity and every rule of that release whose subject is the given record type, read from the immutable release row the save already resolved.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
